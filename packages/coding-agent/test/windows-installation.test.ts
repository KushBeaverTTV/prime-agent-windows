import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getWindowsInstallation,
	readWindowsInstallation,
	type WindowsRelease,
} from "../src/utils/windows-installation.js";

const SHA256 = "a".repeat(64);
const SHA256_OTHER = "b".repeat(64);

interface Fixture {
	root: string;
	release: WindowsRelease;
	releaseDir: string;
	executable: string;
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

function makeRelease(overrides: Partial<WindowsRelease> = {}): WindowsRelease {
	return {
		directory: "0.9.5-windows.1-0123456789abcdef0123456789abcdef",
		version: "0.9.5",
		revision: 1,
		sha256: SHA256,
		...overrides,
	};
}

function makeManagedRoot(
	options: {
		current?: WindowsRelease;
		previous?: WindowsRelease | null;
		marker?: string;
		manifestUrl?: string | null;
		markPrevious?: boolean;
	} = {},
): Fixture {
	const root = mkdtempSync(join(tmpdir(), "prime-win-install-"));
	writeFileSync(join(root, ".windows-managed"), options.marker ?? "prime-agent-windows-v1");
	mkdirSync(join(root, "releases"));
	const release = options.current ?? makeRelease();
	const releaseDir = join(root, "releases", release.directory);
	writeRelease(releaseDir, release.version, release.revision);
	const executable = join(releaseDir, "prime-agent.exe");
	let previous: WindowsRelease | null | undefined = options.previous;
	if (previous === undefined) previous = null;
	if (previous) {
		writeRelease(join(root, "releases", previous.directory), previous.version, previous.revision);
	}
	const state = {
		schema: 1,
		distribution: "prime-agent-windows",
		manifestUrl: options.manifestUrl ?? null,
		current: release,
		previous: previous ?? null,
	};
	writeFileSync(join(root, "active.json"), JSON.stringify(state));
	return { root, release, releaseDir, executable };
}

function writeState(root: string, state: unknown): void {
	writeFileSync(join(root, "active.json"), JSON.stringify(state));
}

describe("readWindowsInstallation", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
	});
	const fixture = (options?: Parameters<typeof makeManagedRoot>[0]) => {
		const created = makeManagedRoot(options);
		cleanups.push(created.root);
		return created;
	};

	it("reads a valid managed installation", () => {
		const { root, release, releaseDir, executable } = fixture();
		const installation = readWindowsInstallation(root);
		expect(installation).toBeDefined();
		expect(installation!.current).toEqual(release);
		expect(installation!.previous).toBeUndefined();
		expect(installation!.executable).toBe(executable);
		expect(installation!.releaseDir).toBe(releaseDir);
		expect(installation!.launcher).toBe(join(root, "prime-agent.cmd"));
		expect(installation!.manifestUrl).toBeUndefined();
	});

	it("reads the previous release and a configured manifest URL", () => {
		const previous = makeRelease({
			directory: "0.9.4-windows.3-fedcba9876543210fedcba9876543210",
			version: "0.9.4",
			revision: 3,
			sha256: SHA256_OTHER,
		});
		const { root } = fixture({ previous, manifestUrl: "https://example.com/windows.json" });
		const installation = readWindowsInstallation(root);
		expect(installation!.previous).toEqual(previous);
		expect(installation!.manifestUrl).toBe("https://example.com/windows.json");
	});

	it("rejects a recorded directory containing traversal", () => {
		const { root, release } = fixture();
		writeState(root, {
			schema: 1,
			distribution: "prime-agent-windows",
			manifestUrl: null,
			current: { ...release, directory: "..\\..\\escape" },
			previous: null,
		});
		expect(readWindowsInstallation(root)).toBeUndefined();
		writeState(root, {
			schema: 1,
			distribution: "prime-agent-windows",
			manifestUrl: null,
			current: { ...release, directory: "nested/dir" },
			previous: null,
		});
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it.each([
		["schema", { schema: 2 }],
		["distribution", { distribution: "prime-agent" }],
		["version", { current: makeRelease({ version: "not-a-version" }) }],
		["sha256", { current: makeRelease({ sha256: "z".repeat(64) }) }],
		["revision zero", { current: makeRelease({ revision: 0 }) }],
		["fractional revision", { current: makeRelease({ revision: 1.5 }) }],
		["revision above int32", { current: makeRelease({ revision: 2_147_483_648 }) }],
		["http manifest", { manifestUrl: "http://example.com/windows.json" }],
		["credentialed manifest", { manifestUrl: "https://user@example.com/windows.json" }],
	])("rejects state with an invalid %s", (_name, patch) => {
		const { root, release } = fixture();
		writeState(root, {
			schema: 1,
			distribution: "prime-agent-windows",
			manifestUrl: null,
			current: release,
			previous: null,
			...patch,
		});
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("rejects a malformed previous release", () => {
		const { root, release } = fixture();
		writeState(root, {
			schema: 1,
			distribution: "prime-agent-windows",
			manifestUrl: null,
			current: release,
			previous: { directory: "..", version: "0.9.4", revision: 1, sha256: SHA256 },
		});
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("rejects a missing or wrong marker", () => {
		const { root } = fixture();
		writeFileSync(join(root, ".windows-managed"), "prime-agent-native-v1");
		expect(readWindowsInstallation(root)).toBeUndefined();
		rmSync(join(root, ".windows-managed"));
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("rejects missing state and missing executable", () => {
		const { root, executable } = fixture();
		rmSync(join(root, "active.json"));
		expect(readWindowsInstallation(root)).toBeUndefined();
		const second = fixture();
		rmSync(second.executable);
		expect(readWindowsInstallation(second.root)).toBeUndefined();
		void executable;
	});

	it("rejects a releases directory that is a link", () => {
		const { root } = fixture();
		const outside = mkdtempSync(join(tmpdir(), "prime-win-outside-"));
		cleanups.push(outside);
		rmSync(join(root, "releases"), { recursive: true });
		symlinkSync(outside, join(root, "releases"), "junction");
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("rejects a release directory that is a link to an outside sibling with the same name", () => {
		const { root, release } = fixture();
		const outside = mkdtempSync(join(tmpdir(), "prime-win-outside-"));
		cleanups.push(outside);
		const outsideRelease = join(outside, release.directory);
		writeRelease(outsideRelease, release.version, release.revision);
		rmSync(join(root, "releases", release.directory), { recursive: true });
		symlinkSync(outsideRelease, join(root, "releases", release.directory), "junction");
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("rejects a nested asset directory that is a link outside the release", () => {
		const { root, releaseDir } = fixture();
		const outside = mkdtempSync(join(tmpdir(), "prime-win-outside-"));
		cleanups.push(outside);
		const outsideNative = join(outside, "native");
		mkdirSync(join(outsideNative, "koffi", "build", "koffi", "win32_x64"), { recursive: true });
		writeFileSync(join(outsideNative, "koffi", "package.json"), "{}");
		writeFileSync(join(outsideNative, "koffi", "build", "koffi", "win32_x64", "koffi.node"), "MZ");
		rmSync(join(releaseDir, "native"), { recursive: true });
		symlinkSync(outsideNative, join(releaseDir, "native"), "junction");
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("rejects a release missing the retained installer or runtime assets", () => {
		const { root, releaseDir } = fixture();
		rmSync(join(releaseDir, "install-windows.ps1"));
		expect(readWindowsInstallation(root)).toBeUndefined();
		const second = fixture();
		rmSync(join(second.releaseDir, "prime-agent-runtime", "src", "rlm", "bash.py"));
		expect(readWindowsInstallation(second.root)).toBeUndefined();
	});

	it("rejects a release whose marker metadata does not match the state record", () => {
		const { root, releaseDir } = fixture();
		writeFileSync(
			join(releaseDir, "windows-release.json"),
			JSON.stringify({
				schema: 1,
				distribution: "prime-agent-windows",
				platform: "windows-x64-baseline",
				version: "0.9.4",
				revision: 1,
			}),
		);
		expect(readWindowsInstallation(root)).toBeUndefined();
		writeFileSync(
			join(releaseDir, "windows-release.json"),
			JSON.stringify({
				schema: 1,
				distribution: "prime-agent",
				platform: "windows-x64-baseline",
				version: "0.9.5",
				revision: 1,
			}),
		);
		expect(readWindowsInstallation(root)).toBeUndefined();
		writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ name: "prime-agent", version: "9.9.9" }));
		writeFileSync(
			join(releaseDir, "windows-release.json"),
			JSON.stringify({
				schema: 1,
				distribution: "prime-agent-windows",
				platform: "windows-x64-baseline",
				version: "0.9.5",
				revision: 1,
			}),
		);
		expect(readWindowsInstallation(root)).toBeUndefined();
	});

	it("reads state written with a byte-order mark", () => {
		const { root, release } = fixture();
		writeFileSync(
			join(root, "active.json"),
			String.fromCharCode(0xfeff) +
				JSON.stringify({
					schema: 1,
					distribution: "prime-agent-windows",
					manifestUrl: null,
					current: release,
					previous: null,
				}),
		);
		expect(readWindowsInstallation(root)?.current).toEqual(release);
	});
});

describe("getWindowsInstallation", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("resolves the active installation from the running executable", () => {
		const { root, executable, release } = makeManagedRoot();
		cleanups.push(root);
		const installation = getWindowsInstallation(executable);
		expect(installation).toBeDefined();
		expect(installation!.root).toBe(root);
		expect(installation!.current).toEqual(release);
	});

	it("returns the active release for an executable in the previous release directory", () => {
		const previous = makeRelease({
			directory: "0.9.4-windows.1-fedcba9876543210fedcba9876543210",
			version: "0.9.4",
			sha256: SHA256_OTHER,
		});
		const { root, release } = makeManagedRoot({ previous });
		cleanups.push(root);
		const oldExecutable = join(root, "releases", previous.directory, "prime-agent.exe");
		const installation = getWindowsInstallation(oldExecutable);
		expect(installation).toBeDefined();
		expect(installation!.current).toEqual(release);
	});

	it("returns undefined for an unmanaged executable", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-win-unmanaged-"));
		cleanups.push(dir);
		const executable = join(dir, "prime-agent.exe");
		writeFileSync(executable, "MZ");
		expect(getWindowsInstallation(executable)).toBeUndefined();
		expect(readFileSync(executable, "utf8")).toBe("MZ");
	});

	it("rejects an arbitrary executable beside the managed one", () => {
		const { root, releaseDir } = makeManagedRoot();
		cleanups.push(root);
		const sibling = join(releaseDir, "other.exe");
		writeFileSync(sibling, "MZ");
		expect(getWindowsInstallation(sibling)).toBeUndefined();
	});

	it("rejects an executable in a damaged previous release", () => {
		const previous = makeRelease({
			directory: "0.9.4-windows.1-fedcba9876543210fedcba9876543210",
			version: "0.9.4",
			sha256: SHA256_OTHER,
		});
		const { root } = makeManagedRoot({ previous });
		cleanups.push(root);
		const previousDir = join(root, "releases", previous.directory);
		rmSync(join(previousDir, "windows-release.json"));
		const oldExecutable = join(previousDir, "prime-agent.exe");
		expect(getWindowsInstallation(oldExecutable)).toBeUndefined();
	});
});
