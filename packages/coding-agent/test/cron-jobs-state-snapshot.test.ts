import type * as FsModule from "node:fs";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentCronJob, AgentCronJobStore, SESSION_SCHEDULED_JOBS_FILENAME } from "../src/core/cron-jobs.js";

const readCounts = vi.hoisted(() => new Map<string, number>());
const renameFault = vi.hoisted(() => ({ remaining: 0, path: "" }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		readFileSync: ((path, options) => {
			const key = String(path);
			readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
			return actual.readFileSync(path, options);
		}) as typeof actual.readFileSync,
		renameSync: ((from, to) => {
			if (renameFault.remaining > 0 && String(to) === renameFault.path) {
				renameFault.remaining--;
				throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
			}
			return actual.renameSync(from, to);
		}) as typeof actual.renameSync,
	};
});

const start = new Date("2026-01-01T12:34:00.000Z");

function jobsReads(path: string): number {
	return readCounts.get(path) ?? 0;
}

/** Rewrite a jobs file the way an external writer would: whole-file replace with an explicit mtime. */
function writeExternalState(path: string, jobs: readonly AgentCronJob[], mtime: Date): void {
	writeFileSync(path, `${JSON.stringify({ jobs, dispatches: [] }, null, 2)}\n`);
	utimesSync(path, mtime, mtime);
}

function externalJob(input: { id: string; prompt: string; sessionId: string; sessionFile: string }): AgentCronJob {
	return {
		id: input.id,
		status: "active",
		activeSessionId: `active-${input.sessionId}`,
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
		cwd: "/tmp/project",
		prompt: input.prompt,
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T12:00:00.000Z",
		updatedAt: "2026-01-01T12:00:00.000Z",
		nextRunAt: "2026-01-01T12:40:00.000Z",
		runCount: 0,
	};
}

function makeTempDir(tempDirs: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-cron-snapshot-"));
	tempDirs.push(dir);
	return dir;
}

describe("AgentCronJobStore state snapshots", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		readCounts.clear();
		renameFault.remaining = 0;
		renameFault.path = "";
	});

	it("serves repeated reads of an unchanged file from the in-memory snapshot", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "snapshot guard",
			now: start,
		});
		readCounts.clear();

		expect(store.list()).toHaveLength(1);
		expect(store.due(new Date("2026-01-01T13:35:00.000Z"))).toHaveLength(1);
		expect(store.getDueJob(store.list()[0]!.id, new Date("2026-01-01T13:35:00.000Z"))).toBeDefined();
		expect(store.nextActiveRunAt()?.toISOString()).toBe("2026-01-01T13:34:00.000Z");
		expect(store.list()).toHaveLength(1);

		expect(jobsReads(storePath)).toBe(0);
	});

	it("publishes the mutated state so the next read does not re-parse the file", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		const job = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "published mutation",
			now: start,
		});
		readCounts.clear();

		expect(store.list().map((candidate) => candidate.id)).toEqual([job.id]);
		expect(store.getHeartbeat("active-1")).toBeUndefined();

		expect(jobsReads(storePath)).toBe(0);
	});

	it("re-reads the file when an external writer changes it and caches the new parse", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "aaaa",
			now: start,
		});
		// Same byte size, different content: only the mtime moves.
		writeExternalState(
			storePath,
			[
				externalJob({
					id: "external-1",
					prompt: "bbbb",
					sessionId: "session-1",
					sessionFile: "/tmp/session-1.jsonl",
				}),
			],
			new Date("2026-01-02T00:00:00.000Z"),
		);
		readCounts.clear();

		expect(store.list().map((candidate) => candidate.prompt)).toEqual(["bbbb"]);
		expect(jobsReads(storePath)).toBe(1);

		expect(store.list().map((candidate) => candidate.prompt)).toEqual(["bbbb"]);
		expect(jobsReads(storePath)).toBe(1);
	});

	it("re-reads when the file is replaced by a fresh inode with the same size and mtime", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "inode guard",
			now: start,
		});
		const pinned = new Date("2026-01-03T00:00:00.000Z");
		utimesSync(storePath, pinned, pinned);
		expect(store.list()).toHaveLength(1);
		const bytes = readFileSync(storePath, "utf-8");
		readCounts.clear();

		rmSync(storePath);
		writeFileSync(storePath, bytes);
		utimesSync(storePath, pinned, pinned);

		expect(store.list()).toHaveLength(1);
		expect(jobsReads(storePath)).toBe(1);
	});

	it("keeps concurrent store instances on one file consistent", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const first = new AgentCronJobStore(storePath);
		const second = new AgentCronJobStore(storePath);
		const jobA = first.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "from first",
			now: start,
		});
		expect(second.list().map((candidate) => candidate.id)).toEqual([jobA.id]);

		const jobB = second.create({
			activeSessionId: "active-2",
			sessionId: "session-2",
			sessionFile: "/tmp/session-2.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 2h",
			prompt: "from second",
			now: start,
		});
		expect(
			first
				.list()
				.map((candidate) => candidate.id)
				.sort(),
		).toEqual([jobA.id, jobB.id].sort());

		writeExternalState(storePath, [], new Date("2026-01-04T00:00:00.000Z"));
		expect(first.list()).toEqual([]);
		expect(second.list()).toEqual([]);

		writeExternalState(
			storePath,
			[
				externalJob({
					id: "external-1",
					prompt: "external writer",
					sessionId: "session-1",
					sessionFile: "/tmp/session-1.jsonl",
				}),
			],
			new Date("2026-01-05T00:00:00.000Z"),
		);
		expect(first.list().map((candidate) => candidate.id)).toEqual(["external-1"]);
		expect(second.list().map((candidate) => candidate.id)).toEqual(["external-1"]);
	});

	it("drops the snapshot when a mutation fails to persist and re-reads the disk", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		const first = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "survives",
			now: start,
		});
		readCounts.clear();
		expect(store.list().map((candidate) => candidate.id)).toEqual([first.id]);
		expect(jobsReads(storePath)).toBe(0);

		renameFault.remaining = 1;
		renameFault.path = storePath;
		expect(() =>
			store.create({
				activeSessionId: "active-2",
				sessionId: "session-2",
				sessionFile: "/tmp/session-2.jsonl",
				cwd: "/tmp/project",
				scheduleText: "in 1h",
				prompt: "never lands",
				now: start,
			}),
		).toThrow();

		readCounts.clear();
		expect(store.list().map((candidate) => candidate.id)).toEqual([first.id]);
		expect(jobsReads(storePath)).toBe(1);
	});

	it("serves an empty state while the file is missing and reloads it when it appears", () => {
		const storePath = join(makeTempDir(tempDirs), "cron-jobs.json");
		const store = new AgentCronJobStore(storePath);
		expect(store.list()).toEqual([]);
		writeExternalState(
			storePath,
			[
				externalJob({
					id: "external-1",
					prompt: "appears later",
					sessionId: "session-1",
					sessionFile: "/tmp/session-1.jsonl",
				}),
			],
			new Date("2026-01-06T00:00:00.000Z"),
		);
		expect(store.list().map((candidate) => candidate.id)).toEqual(["external-1"]);
		readCounts.clear();
		expect(store.list()).toHaveLength(1);
		expect(jobsReads(storePath)).toBe(0);
	});

	it("caches per registered session artifact and re-reads only the changed file", () => {
		const root = makeTempDir(tempDirs);
		const store = AgentCronJobStore.forSessionArtifacts();
		const firstDir = join(root, "artifacts-1");
		const secondDir = join(root, "artifacts-2");
		store.registerSessionArtifact("session-1", firstDir);
		store.registerSessionArtifact("session-2", secondDir);
		store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(root, "session-1.jsonl"),
			cwd: root,
			scheduleText: "every 5m",
			prompt: "first heartbeat",
			now: start,
		});
		store.createHeartbeat({
			activeSessionId: "active-2",
			sessionId: "session-2",
			sessionFile: join(root, "session-2.jsonl"),
			cwd: root,
			scheduleText: "every 5m",
			prompt: "second heartbeat",
			now: start,
		});
		const firstPath = join(firstDir, SESSION_SCHEDULED_JOBS_FILENAME);
		const secondPath = join(secondDir, SESSION_SCHEDULED_JOBS_FILENAME);
		readCounts.clear();

		expect(store.list()).toHaveLength(2);
		expect(jobsReads(firstPath)).toBe(0);
		expect(jobsReads(secondPath)).toBe(0);

		writeExternalState(
			firstPath,
			[
				externalJob({
					id: "external-1",
					prompt: "rewritten externally",
					sessionId: "session-1",
					sessionFile: join(root, "session-1.jsonl"),
				}),
			],
			new Date("2026-01-07T00:00:00.000Z"),
		);
		expect(store.list().map((candidate) => candidate.prompt)).toEqual(
			expect.arrayContaining(["rewritten externally", "second heartbeat"]),
		);
		expect(jobsReads(firstPath)).toBe(1);
		expect(jobsReads(secondPath)).toBe(0);
	});
});
