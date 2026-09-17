import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { DaemonClient } from "../packages/coding-agent/src/modes/daemon/daemon-client.js";
import { isProcessAlive, waitForChildProcess } from "../packages/coding-agent/src/utils/child-process.js";
import type { DaemonResponse } from "../packages/coding-agent/src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../packages/coding-agent/src/modes/daemon/daemon-session-list.js";

function argValue(flag: string): string {
	const index = process.argv.indexOf(flag);
	assert(index !== -1 && index + 1 < process.argv.length, `missing ${flag}`);
	return process.argv[index + 1];
}

assert.equal(process.platform, "win32", "test-windows-artifact must run on native Windows");

const binaryDir = resolve(argValue("--binary-dir"));
const uv = resolve(argValue("--uv"));
const exePath = join(binaryDir, "prime-agent.exe");
assert.ok(existsSync(exePath), `missing compiled executable: ${exePath}`);
assert.ok(existsSync(uv), `missing uv: ${uv}`);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO_ROOT, "packages", "coding-agent", "test", "fixtures", "compiled-artifact-extension.ts");
assert.ok(existsSync(FIXTURE), `missing lead-authored fixture: ${FIXTURE}`);

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const root = mkdtempSync(join(tmpdir(), "prime-artifact "));
mkdirSync(join(root, ".git"));
const dir = join(root, "binaries");
const cwd = join(root, "project \u00e4");
const home = join(root, "home");
const agentDir = join(root, "agent");
const kernelVenv = join(root, "kernel-venv");
const tools = join(root, "tools");
mkdirSync(cwd, { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(tools, { recursive: true });
copyFileSync(uv, join(tools, "uv.exe"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
cpSync(binaryDir, dir, { recursive: true });
const exe = join(dir, "prime-agent.exe");
assert.ok(existsSync(exe), `copied executable missing: ${exe}`);
copyFileSync(FIXTURE, join(cwd, "extension.ts"));

const socket = `\\\\.\\pipe\\prime-windows-artifact-${randomUUID()}`;
const env: NodeJS.ProcessEnv = {
	SystemRoot: process.env.SystemRoot,
	SystemDrive: process.env.SystemDrive,
	ComSpec: process.env.ComSpec,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
	USERPROFILE: home,
	HOME: home,
	PRIME_AGENT_CODING_AGENT_DIR: agentDir,
	PRIME_AGENT_KERNEL_VENV: kernelVenv,
	DO_NOT_TRACK: "1",
	PRIME_AGENT_INSTALL_UV: "0",
	PATH: [join(systemRoot, "System32"), join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), tools].join(";"),
};
const taskkill = join(systemRoot, "System32", "taskkill.exe");
assert.ok(!/[\\/]node_modules/i.test(env.PATH ?? ""), "child PATH must not contain checkout dependencies");

const children = new Set<ChildProcess>();
const clients = new Set<DaemonClient>();
let supervisorPid: number | undefined;

function daemonClient(): DaemonClient {
	const client = new DaemonClient(socket);
	clients.add(client);
	return client;
}

function killTree(pid: number): void {
	spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

async function run(
	args: string[],
	options: { timeout?: number; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = spawn(exe, args, {
		cwd,
		env: { ...env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout!.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
	child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	if (options.stdin !== undefined) {
		child.stdin!.write(options.stdin);
	}
	child.stdin!.end();
	const timeout = options.timeout ?? 120_000;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid !== undefined) killTree(child.pid);
	}, timeout);
	try {
		const code = await waitForChildProcess(child);
		if (timedOut) throw new Error(`timeout ${timeout}ms running: ${args.join(" ")}`);
		return {
			code: code ?? 1,
			stdout: Buffer.concat(stdoutChunks).toString("utf8"),
			stderr: Buffer.concat(stderrChunks).toString("utf8"),
		};
	} catch (error) {
		if (child.pid !== undefined && isProcessAlive(child.pid)) {
			killTree(child.pid);
			await Promise.race([
				waitForChildProcess(child).catch(() => {}),
				new Promise<void>((resolveBound) => setTimeout(resolveBound, 15_000).unref()),
			]);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		children.delete(child);
		child.stdin!.destroy();
	}
}

function sessionArgs(): string[] {
	return [
		"--offline",
		"--daemon-socket",
		socket,
		"--no-context-files",
		"--no-extensions",
		"-e",
		join(cwd, "extension.ts"),
		"--provider",
		"artifact-faux",
		"--model",
		"artifact",
	];
}

function responseData<T>(response: DaemonResponse): T {
	assert.equal(response.success, true, `daemon command failed: ${JSON.stringify(response)}`);
	return (response as { data?: T }).data as T;
}

function findFile(baseDir: string, name: string): string | undefined {
	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		const full = join(baseDir, entry.name);
		if (entry.isDirectory()) {
			const found = findFile(full, name);
			if (found) return found;
		} else if (entry.name === name) {
			return full;
		}
	}
	return undefined;
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

function generatePng(): Buffer {
	const width = 3000;
	const raw = Buffer.alloc(1 + width * 3);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

let daemonGone = false;

async function shutdownDaemon(): Promise<void> {
	if (daemonGone) return;
	if (supervisorPid !== undefined && !isProcessAlive(supervisorPid)) {
		daemonGone = true;
		return;
	}
	const shutdownClient = daemonClient();
	try {
		await shutdownClient.connect(5_000);
		const hello = await shutdownClient.waitForHello(5_000);
		supervisorPid = hello.supervisorPid ?? supervisorPid;
		const socketClosed = new Promise<void>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(
				() => rejectPromise(new Error("daemon socket did not close after shutdown request")),
				15_000,
			);
			shutdownClient.onClose(() => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
		try {
			await shutdownClient.request({ type: "shutdown", force: true }, 15_000);
		} catch (error) {
			if (shutdownClient.isConnected) throw error;
		}
		await socketClosed;
	} catch (error) {
		if (supervisorPid === undefined) {
			daemonGone = true;
			return;
		}
		if (!isProcessAlive(supervisorPid)) {
			daemonGone = true;
			return;
		}
		killTree(supervisorPid);
		if (isProcessAlive(supervisorPid)) {
			throw new Error(`daemon supervisor ${supervisorPid} could not be stopped: ${error}`);
		}
	}
	daemonGone = true;
}

function cleanupRoot(): void {
	for (const client of clients) client.close();
	for (const child of children) {
		if (child.pid !== undefined) killTree(child.pid);
	}
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function main(): Promise<void> {
	for (const flag of ["--version", "--help", "--windows-runtime-probe"]) {
		const result = await run([flag]);
		assert.equal(result.code, 0, `${flag} failed: ${result.stderr}`);
	}

	const standard = await run([...sessionArgs(), "--no-tools", "-p", "artifact test"], { timeout: 120_000 });
	assert.equal(standard.code, 0, `standard run failed: ${standard.stderr}`);
	assert.equal(standard.stdout.trim(), `artifact-ok:${"x".repeat(131072)}:complete`);

	const loadedAssetsPath = findFile(root, "loaded-assets.json");
	assert.ok(loadedAssetsPath, `loaded-assets.json not written anywhere under ${root}`);
	console.log(`loaded-assets.json at ${loadedAssetsPath}`);
	const loadedAssets = JSON.parse(readFileSync(loadedAssetsPath, "utf8")) as { skills: string[] };
	assert.ok(loadedAssets.skills.length > 0, "fixture reported no skills");

	const client = daemonClient();
	await client.connect(10_000);
	const hello = await client.waitForHello(10_000);
	assert.equal(hello.runtime?.executablePath, exe, "daemon runtime executablePath mismatch");
	supervisorPid = hello.supervisorPid;
	const list = responseData<{ sessions: SessionSummary[] }>(
		await client.request({ type: "list", all: true }),
	);
	assert.ok(list.sessions.length > 0, "daemon list returned no sessions");
	const listed = list.sessions[0];
	let activeSessionId = listed.activeSessionId;
	if (!activeSessionId) {
		assert.ok(listed.sessionFile, "listed session has neither activeSessionId nor sessionFile");
		const created = responseData<SessionSummary>(
			await client.request({ type: "create", sessionPath: listed.sessionFile }),
		);
		activeSessionId = created.activeSessionId;
	}
	assert.ok(activeSessionId, "could not resolve an active session for attach");

	const attach = responseData<{ snapshot: { messages: unknown[] } }>(
		await client.request({ type: "attach", activeSessionId }),
	);
	assert.ok(
		JSON.stringify(attach.snapshot.messages).includes("artifact-ok"),
		"attached session messages missing artifact marker",
	);
	assert.equal((await client.request({ type: "detach", activeSessionId })).success, true, "detach failed");

	const client2 = daemonClient();
	await client2.connect(10_000);
	await client2.waitForHello(10_000);
	const reattach = responseData<{ snapshot: { messages: unknown[] } }>(
		await client2.request({ type: "attach", activeSessionId }),
	);
	assert.ok(
		JSON.stringify(reattach.snapshot.messages).includes("artifact-ok"),
		"reattached session messages missing artifact marker",
	);
	assert.equal((await client2.request({ type: "detach", activeSessionId })).success, true, "second detach failed");
	client2.close();

	const cronAdded = responseData<{ job: { id: string } }>(
		await client.request({ type: "cron_add", activeSessionId, schedule: "every 1h", prompt: "check status" }),
	);
	const cronListed = responseData<{ jobs: { id: string }[] }>(
		await client.request({ type: "cron_list", activeSessionId }),
	);
	assert.ok(
		cronListed.jobs.some((job) => job.id === cronAdded.job.id),
		"added cron job missing from cron_list",
	);
	assert.equal(
		(await client.request({ type: "cron_cancel", activeSessionId, jobId: cronAdded.job.id })).success,
		true,
		"cron_cancel failed",
	);
	const cronAfter = responseData<{ jobs: { id: string }[] }>(
		await client.request({ type: "cron_list", activeSessionId }),
	);
	assert.ok(
		!cronAfter.jobs.some((job) => job.id === cronAdded.job.id),
		"cancelled cron job still listed",
	);

	assert.equal(
		client.supportsServerCapability("heartbeat_catalog"),
		true,
		"daemon did not declare heartbeat_catalog capability",
	);
	assert.equal(
		(await client.request({ type: "heartbeats_list", activeSessionId })).success,
		true,
		"heartbeats_list failed despite heartbeat_catalog capability",
	);

	const rpc = await run(
		[...sessionArgs(), "--no-tools", "--mode", "rpc"],
		{
			stdin: `${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "shell", type: "bash", command: "Write-Output 'artifact-rpc-shell'" })}\n`,
		},
	);
	assert.equal(rpc.code, 0, `rpc run failed: ${rpc.stderr}`);
	const frames = rpc.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { id?: string; success?: boolean; data?: unknown });
	const stateFrame = frames.find((frame) => frame.id === "state");
	assert.ok(stateFrame?.success === true, "RPC get_state frame missing or failed");
	assert.equal(
		(stateFrame.data as { model?: { provider?: string } }).model?.provider,
		"artifact-faux",
		"RPC state provider mismatch",
	);
	const shellFrame = frames.find((frame) => frame.id === "shell");
	assert.ok(shellFrame?.success === true, "RPC bash frame missing or failed");
	const bashData = shellFrame.data as { exitCode?: number; output?: string };
	assert.equal(bashData.exitCode, 0, "RPC bash exitCode nonzero");
	assert.ok(
		(bashData.output ?? "").trim().includes("artifact-rpc-shell"),
		`RPC bash output missing marker: ${bashData.output}`,
	);

	const python = await run([...sessionArgs(), "--tools", "ipython", "-p", "artifact python"], {
		timeout: 300_000,
		env: { PRIME_AGENT_ARTIFACT_CASE: "python" },
	});
	assert.equal(python.code, 0, `python run failed: ${python.stderr}`);
	assert.ok(python.stdout.includes("artifact-python-result 42"), `missing python marker: ${python.stdout}`);
	assert.ok(python.stdout.includes("artifact-shell-ok"), `missing shell marker: ${python.stdout}`);
	const bootstrap = JSON.parse(readFileSync(join(kernelVenv, ".bootstrap-version"), "utf8")) as {
		pythonSkills?: { packagePath: string }[];
	};
	assert.ok(bootstrap.pythonSkills && bootstrap.pythonSkills.length > 0, "bootstrap-version missing pythonSkills");
	for (const skill of bootstrap.pythonSkills) {
		assert.ok(
			skill.packagePath.startsWith(dir),
			`python skill resolved outside packaged runtime: ${skill.packagePath}`,
		);
	}

	const subagent = await run([...sessionArgs(), "--tools", "ipython", "-p", "artifact subagent"], {
		timeout: 300_000,
		env: { PRIME_AGENT_ARTIFACT_CASE: "subagent" },
	});
	assert.equal(subagent.code, 0, `subagent run failed: ${subagent.stderr}`);
	assert.ok(
		subagent.stdout.includes("artifact-subagent-ok"),
		`missing subagent marker: ${subagent.stdout}`,
	);

	const imagePath = join(cwd, "wide.png");
	writeFileSync(imagePath, generatePng());
	const image = await run([...sessionArgs(), "--no-tools", "-p", "@wide.png", "artifact image"], {
		timeout: 300_000,
		env: { PRIME_AGENT_ARTIFACT_CASE: "image" },
	});
	assert.equal(image.code, 0, `image run failed: ${image.stderr}`);
	const sessionsDir = join(agentDir, "sessions");
	const sessionFiles: string[] = [];
	const collect = (dirPath: string) => {
		for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
			const full = join(dirPath, entry.name);
			if (entry.isDirectory()) collect(full);
			else if (entry.name.endsWith(".jsonl")) sessionFiles.push(full);
		}
	};
	collect(sessionsDir);
	const imageSession = sessionFiles.find((file) => readFileSync(file, "utf8").includes("wide.png"));
	assert.ok(imageSession, "no session jsonl records the image run");
	const htmlPath = join(cwd, "export.html");
	const exportResult = await run(["session", "export", imageSession, htmlPath]);
	assert.equal(exportResult.code, 0, `session export failed: ${exportResult.stderr}`);
	const html = readFileSync(htmlPath, "utf8");
	const encoded = html.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/)?.[1];
	assert.ok(encoded, "HTML export must embed its session data");
	assert.ok(
		Buffer.from(encoded, "base64").toString("utf8").includes("artifact image"),
		"exported HTML session data missing image prompt",
	);
}

main()
	.then(() => {
		console.log("test-windows-artifact: all checks passed");
	})
	.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		try {
			await shutdownDaemon();
			cleanupRoot();
		} catch (error) {
			console.error(error);
			process.exitCode = 1;
		}
	});
