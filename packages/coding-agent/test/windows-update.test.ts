import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWindowsUpdatePlan } from "../src/cli/windows-update.js";
import type * as ShellUtils from "../src/utils/shell.js";

vi.mock("../src/utils/shell.js", async (importOriginal) => {
	const actual = await importOriginal<typeof ShellUtils>();
	return { ...actual, getWindowsPowerShell: () => "C:\\Tools\\pwsh.exe" };
});

const SHA256 = "a".repeat(64);
const NEXT_SHA256 = "b".repeat(64);
const MANIFEST_URL = "https://windows.example/releases/windows.json";

interface ManagedFixture {
	root: string;
	releaseDir: string;
	executable: string;
	directory: string;
}

const RELEASE_FILES = [
	"prime-agent.exe",
	"package.json",
	"install-windows.ps1",
	"prime-agent.ps1",
	"prime-agent-runtime/pyproject.toml",
	"prime-agent-runtime/src/rlm/repl.py",
	"prime-agent-runtime/src/rlm/bash.py",
	"theme/prime.json",
	"export-html/template.html",
	"photon_rs_bg.wasm",
	"native/koffi/package.json",
	"native/koffi/build/koffi/win32_x64/koffi.node",
];

function writeRelease(releaseDir: string, version: string, revision: number): void {
	mkdirSync(releaseDir, { recursive: true });
	for (const relative of RELEASE_FILES) {
		const target = join(releaseDir, ...relative.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, relative === "prime-agent.exe" ? "MZ" : "{}");
	}
	writeFileSync(
		join(releaseDir, "windows-release.json"),
		JSON.stringify({
			schema: 1,
			distribution: "prime-agent-windows",
			platform: "windows-x64-baseline",
			version,
			revision,
		}),
	);
	writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ name: "prime-agent", version }));
}

function makeManagedInstall(
	options: { version?: string; revision?: number; previous?: boolean; manifestUrl?: string | null } = {},
): ManagedFixture {
	const root = mkdtempSync(join(tmpdir(), "prime-win-update-"));
	writeFileSync(join(root, ".windows-managed"), "prime-agent-windows-v1");
	mkdirSync(join(root, "releases"));
	const version = options.version ?? "0.9.5";
	const revision = options.revision ?? 1;
	const directory = `${version}-windows.${revision}-0123456789abcdef0123456789abcdef`;
	const releaseDir = join(root, "releases", directory);
	writeRelease(releaseDir, version, revision);
	const executable = join(releaseDir, "prime-agent.exe");
	let previous: unknown = null;
	if (options.previous) {
		const previousDirectory = "0.9.4-windows.1-fedcba9876543210fedcba9876543210";
		const previousDir = join(root, "releases", previousDirectory);
		writeRelease(previousDir, "0.9.4", 1);
		previous = { directory: previousDirectory, version: "0.9.4", revision: 1, sha256: "c".repeat(64) };
	}
	writeFileSync(
		join(root, "active.json"),
		JSON.stringify({
			schema: 1,
			distribution: "prime-agent-windows",
			manifestUrl: options.manifestUrl === undefined ? MANIFEST_URL : options.manifestUrl,
			current: { directory, version, revision, sha256: SHA256 },
			previous,
		}),
	);
	return { root, releaseDir, executable, directory };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: 1,
		distribution: "prime-agent-windows",
		platform: "windows-x64-baseline",
		version: "0.9.6",
		revision: 1,
		file: "prime-agent-0.9.6-windows-x64-baseline-1.zip",
		sha256: NEXT_SHA256,
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("getWindowsUpdatePlan", () => {
	const cleanups: string[] = [];
	const fetchMock = vi.fn();
	afterEach(() => {
		vi.unstubAllGlobals();
		fetchMock.mockReset();
		for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
	});
	function fixture(options?: Parameters<typeof makeManagedInstall>[0]): ManagedFixture {
		const created = makeManagedInstall(options);
		cleanups.push(created.root);
		return created;
	}
	function stubManifest(body: unknown, status = 200): void {
		fetchMock.mockImplementation(async () => jsonResponse(body, status));
		vi.stubGlobal("fetch", fetchMock);
	}

	it("refuses an unmanaged executable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-win-unmanaged-"));
		cleanups.push(dir);
		const unmanaged = join(dir, "prime-agent.exe");
		writeFileSync(unmanaged, "MZ");
		await expect(getWindowsUpdatePlan({ force: false, rollback: false, executable: unmanaged })).rejects.toThrow(
			/install-windows\.ps1/,
		);
	});

	it("refuses the nightly channel", async () => {
		const { executable } = fixture();
		await expect(
			getWindowsUpdatePlan({ force: false, rollback: false, channel: "nightly", executable }),
		).rejects.toThrow(/stable/);
	});

	it("refuses when no manifest channel is configured", async () => {
		const { executable } = fixture({ manifestUrl: null });
		await expect(getWindowsUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(
			/No Windows update channel configured/,
		);
	});

	it("plans an update through the retained installer", async () => {
		const { executable, root, releaseDir, directory } = fixture();
		stubManifest(manifest());
		const plan = await getWindowsUpdatePlan({ force: false, rollback: false, executable });
		expect(plan.targetVersion).toBe("0.9.6");
		expect(plan.command).toBeDefined();
		expect(plan.command!.command).toBe("C:\\Tools\\pwsh.exe");
		expect(plan.command!.args).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-File",
			join(releaseDir, "install-windows.ps1"),
			"-ArchiveUrl",
			"https://windows.example/releases/prime-agent-0.9.6-windows-x64-baseline-1.zip",
			"-ExpectedSha256",
			NEXT_SHA256,
			"-InstallDir",
			root,
			"-ManifestUrl",
			MANIFEST_URL,
			"-ExpectedCurrent",
			directory,
			"-ExpectedVersion",
			"0.9.6",
			"-ExpectedRevision",
			"1",
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("plans a same-version revision bump", async () => {
		const { executable } = fixture();
		stubManifest(manifest({ version: "0.9.5", revision: 2, file: "prime-agent-0.9.5-windows-x64-baseline-2.zip" }));
		const plan = await getWindowsUpdatePlan({ force: false, rollback: false, executable });
		expect(plan.targetVersion).toBe("0.9.5");
		expect(plan.command!.args).toContain("-ExpectedRevision");
		expect(plan.command!.args[plan.command!.args.indexOf("-ExpectedRevision") + 1]).toBe("2");
	});

	it("is a no-op for the installed release", async () => {
		const { executable } = fixture();
		stubManifest(manifest({ version: "0.9.5", revision: 1, file: "prime-agent-0.9.5-windows-x64-baseline-1.zip" }));
		const plan = await getWindowsUpdatePlan({ force: false, rollback: false, executable });
		expect(plan.command).toBeUndefined();
		expect(plan.targetVersion).toBe("0.9.5");
	});

	it("plans a forced reinstall of the installed release", async () => {
		const { executable } = fixture();
		stubManifest(manifest({ version: "0.9.5", revision: 1, file: "prime-agent-0.9.5-windows-x64-baseline-1.zip" }));
		const plan = await getWindowsUpdatePlan({ force: true, rollback: false, executable });
		expect(plan.command).toBeDefined();
		expect(plan.command!.args).toContain("-Force");
	});

	it.each([
		[
			"older version",
			{},
			manifest({ version: "0.9.4", revision: 9, file: "prime-agent-0.9.4-windows-x64-baseline-9.zip" }),
		],
		[
			"older revision",
			{ revision: 2 },
			manifest({ version: "0.9.5", revision: 1, file: "prime-agent-0.9.5-windows-x64-baseline-1.zip" }),
		],
	])("refuses an %s even with force", async (_name, options, body) => {
		const { executable } = fixture(options);
		stubManifest(body);
		const plan = await getWindowsUpdatePlan({ force: true, rollback: false, executable });
		expect(plan.command).toBeUndefined();
		expect(plan.refusedDowngradeTo).toBe(body.version);
	});

	it.each([
		["distribution", { distribution: "prime-agent" }],
		["platform", { platform: "linux-x64" }],
		["checksum", { sha256: "z".repeat(64) }],
		["version", { version: "latest" }],
		["revision", { revision: -1 }],
		["revision above int32", { revision: 2_147_483_648 }],
		["archive path", { file: "../escape.zip" }],
		["archive without zip suffix", { file: "prime-agent.tar.gz" }],
		["schema", { schema: 2 }],
	])("rejects a manifest with an invalid %s", async (_name, patch) => {
		const { executable } = fixture();
		stubManifest(manifest(patch));
		await expect(getWindowsUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow();
	});

	it("rejects a manifest missing the Windows schema entirely", async () => {
		const { executable } = fixture();
		stubManifest({ version: "0.9.6", package: "prime-agent", binaries: [] });
		await expect(getWindowsUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(
			/schema|distribution/i,
		);
	});

	it("follows HTTPS redirects but rejects a downgrade to HTTP", async () => {
		const { executable } = fixture();
		fetchMock
			.mockImplementationOnce(
				async () => new Response(null, { status: 302, headers: { location: "https://cdn.example/windows.json" } }),
			)
			.mockImplementationOnce(async () => jsonResponse(manifest()));
		vi.stubGlobal("fetch", fetchMock);
		const plan = await getWindowsUpdatePlan({ force: false, rollback: false, executable });
		expect(plan.targetVersion).toBe("0.9.6");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const second = fixture();
		fetchMock.mockReset();
		fetchMock.mockImplementation(
			async () => new Response(null, { status: 302, headers: { location: "http://cdn.example/windows.json" } }),
		);
		await expect(
			getWindowsUpdatePlan({ force: false, rollback: false, executable: second.executable }),
		).rejects.toThrow(/HTTPS/i);
	});

	it("resolves the archive URL against the configured manifest URL, not the redirect target", async () => {
		const configuredUrl =
			"https://github.com/KushBeaverTTV/prime-agent-windows/releases/latest/download/windows.json";
		const { executable } = fixture({ manifestUrl: configuredUrl });
		fetchMock
			.mockImplementationOnce(
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: "https://release-assets.githubusercontent.com/example/signed?sig=x" },
					}),
			)
			.mockImplementationOnce(async () => jsonResponse(manifest()));
		vi.stubGlobal("fetch", fetchMock);
		const plan = await getWindowsUpdatePlan({ force: false, rollback: false, executable });
		expect(plan.command).toBeDefined();
		expect(plan.command!.args).toContain("-ArchiveUrl");
		const urlIndex = plan.command!.args.indexOf("-ArchiveUrl") + 1;
		expect(plan.command!.args[urlIndex]).toBe(
			"https://github.com/KushBeaverTTV/prime-agent-windows/releases/latest/download/prime-agent-0.9.6-windows-x64-baseline-1.zip",
		);
	});

	it("rejects credentialed redirect targets", async () => {
		const { executable } = fixture();
		fetchMock.mockImplementation(
			async () => new Response(null, { status: 302, headers: { location: "https://user@example.com/x.json" } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(getWindowsUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(/credential/i);
	});

	it("fails on an unresolvable manifest endpoint", async () => {
		const { executable } = fixture();
		fetchMock.mockImplementation(async () => jsonResponse({}, 404));
		vi.stubGlobal("fetch", fetchMock);
		await expect(getWindowsUpdatePlan({ force: false, rollback: false, executable })).rejects.toThrow(/HTTP 404/);
	});

	it("plans a rollback through the retained installer", async () => {
		const { executable, root, releaseDir, directory } = fixture({ previous: true });
		const plan = await getWindowsUpdatePlan({ force: false, rollback: true, executable });
		expect(plan.targetVersion).toBe("0.9.4");
		expect(plan.command!.args).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-File",
			join(releaseDir, "install-windows.ps1"),
			"-Rollback",
			"-InstallDir",
			root,
			"-ExpectedCurrent",
			directory,
		]);
	});

	it("refuses a rollback without a previous release", async () => {
		const { executable } = fixture();
		await expect(getWindowsUpdatePlan({ force: false, rollback: true, executable })).rejects.toThrow(/previous/i);
	});
});
