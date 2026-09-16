import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../../../src/core/cron-jobs.js";
import * as sessionManager from "../../../src/core/session-manager.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { RlmSpawnLedger } from "../../../src/modes/daemon/rlm-ledger.js";
import { createHarness, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

interface SupervisorHarness {
	defaultSessionConfig: { agentDir: string };
	rlmSpawnLedger(): RlmSpawnLedger;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	broadcastHeartbeatsChanged(): void;
	passiveScheduledJobs?: { rows: unknown[]; scannedAt: number };
}

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createSupervisorHarness(): Promise<SupervisorHarness> {
	const harness = await createHarness();
	harnesses.push(harness);
	const directory = harness.tempDir;
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function createSavedSession(directory: string, name: string) {
	const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
	manager.newSession();
	manager.appendSessionInfo(name);
	manager.appendMessage({ role: "user", content: name, timestamp: 1 });
	manager.flushNow();
	return manager;
}

function armPassiveHeartbeat(manager: sessionManager.SessionManager, directory: string) {
	const store = AgentCronJobStore.forSessionArtifacts();
	store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
	return store.createHeartbeat({
		activeSessionId: manager.getSessionId(),
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile()!,
		cwd: directory,
		scheduleText: "every 1h",
		prompt: "continue",
	});
}

function listHeartbeats(supervisor: SupervisorHarness, id: string) {
	return supervisor.handleCommand({} as DaemonSocketClient, { id, type: "heartbeats_list" });
}

function within(ms: number, label: string): Promise<never> {
	return new Promise((_, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
		timer.unref?.();
	});
}

function heartbeatIds(response: DaemonResponse | undefined): string[] {
	const data = (response as { data?: { heartbeats?: Array<{ job: { id: string; status: string } }> } }).data;
	return (data?.heartbeats ?? []).map((heartbeat) => heartbeat.job.id);
}

function heartbeatStatus(response: DaemonResponse | undefined, jobId: string): string {
	const data = (response as { data?: { heartbeats?: Array<{ job: { id: string; status: string } }> } }).data;
	return data?.heartbeats?.find((heartbeat) => heartbeat.job.id === jobId)?.job.status ?? "";
}

describe("heartbeats_list response latency", () => {
	it("shares one scheduled-catalog scan across concurrent heartbeats_list requests", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		const responses = await Promise.all(
			["list-1", "list-2", "list-3", "list-4", "list-5"].map((id) => listHeartbeats(supervisor, id)),
		);
		for (const response of responses) {
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
		}
		// One scan served all five concurrent requests instead of one each.
		expect(family).toHaveBeenCalledTimes(1);
		// The stored snapshot serves later requests without any rescan.
		await expect(listHeartbeats(supervisor, "list-6")).resolves.toMatchObject({ success: true });
		expect(family).toHaveBeenCalledTimes(1);
	});

	it("answers from the stored snapshot while a saved-session scan is in flight", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const sessionFile = manager.getSessionFile()!;

		// Warm the shared snapshot.
		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });

		// A sibling metadata scan (cold chat opens, renames) stalls mid-read.
		const readSessionInfo = sessionManager.readSessionInfo;
		const scanStarted = createDeferred();
		const releaseScan = createDeferred();
		const readSpy = vi.spyOn(sessionManager, "readSessionInfo").mockImplementation(async (...args) => {
			scanStarted.resolve();
			await releaseScan.promise;
			return readSessionInfo(...args);
		});
		const siblings = supervisor.rlmSpawnLedger().siblings(sessionFile);
		await scanStarted.promise;
		const readsAtBlock = readSpy.mock.calls.length;

		// The catalog request must answer from the snapshot without joining
		// the blocked scan or waiting on the serialized ledger queue.
		const listPromise = listHeartbeats(supervisor, "list-1");
		try {
			const response = await Promise.race([listPromise, within(1_000, "the snapshot-served heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
			expect(readSpy.mock.calls.length).toBe(readsAtBlock);
		} finally {
			releaseScan.resolve();
			await siblings;
			// Drain a deadline-lost request so it cannot leak into later tests.
			await listPromise.catch(() => undefined);
			readSpy.mockRestore();
		}
	});

	it("does not queue a cold heartbeats_list behind a sibling metadata scan", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const sessionFile = manager.getSessionFile()!;

		// The sibling scan blocks inside its first metadata read; the catalog
		// scan must not wait for that read to finish.
		const readSessionInfo = sessionManager.readSessionInfo;
		const scanStarted = createDeferred();
		const releaseScan = createDeferred();
		let firstRead = true;
		const readSpy = vi.spyOn(sessionManager, "readSessionInfo").mockImplementation(async (...args) => {
			if (firstRead) {
				firstRead = false;
				scanStarted.resolve();
				await releaseScan.promise;
			}
			return readSessionInfo(...args);
		});
		const siblings = supervisor.rlmSpawnLedger().siblings(sessionFile);
		await scanStarted.promise;

		const listPromise = listHeartbeats(supervisor, "list-1");
		try {
			const response = await Promise.race([listPromise, within(1_000, "the cold heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
		} finally {
			releaseScan.resolve();
			await siblings;
			// Drain a deadline-lost request so it cannot leak into later tests.
			await listPromise.catch(() => undefined);
			readSpy.mockRestore();
		}
	});

	it("keeps catalog rows correct after create, update, and delete", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);

		expect(heartbeatIds(await listHeartbeats(supervisor, "list-1"))).toEqual([]);

		// A durable create lands (as every daemon-owned mutation does) with a
		// heartbeats_changed broadcast that drops the stored snapshot.
		const job = store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		});
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "list-2"))).toEqual([job.id]);

		store.manageHeartbeat(manager.getSessionId(), job.id, "pause");
		supervisor.broadcastHeartbeatsChanged();
		const paused = await listHeartbeats(supervisor, "list-3");
		expect(heartbeatIds(paused)).toEqual([job.id]);
		expect(heartbeatStatus(paused, job.id)).toBe("paused");

		store.manageHeartbeat(manager.getSessionId(), job.id, "stop");
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "list-4"))).toEqual([]);
	});

	it("refreshes an aged snapshot in the background while still serving it", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });
		expect(family).toHaveBeenCalledTimes(1);

		// Age the snapshot past the refresh floor.
		supervisor.passiveScheduledJobs!.scannedAt = Date.now() - 60_000;
		const response = await Promise.race([
			listHeartbeats(supervisor, "list-1"),
			within(1_000, "the stale-served heartbeats_list"),
		]);
		expect(response).toMatchObject({ success: true });
		expect(heartbeatIds(response)).toEqual([job.id]);

		// The aged snapshot triggered a background refresh; a later request
		// reads the refreshed snapshot without another scan.
		await vi.waitFor(() => expect(family).toHaveBeenCalledTimes(2));
		await expect(listHeartbeats(supervisor, "list-2")).resolves.toMatchObject({ success: true });
		expect(family).toHaveBeenCalledTimes(2);
	});
});
