import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const MANAGED_MARKER = "prime-agent-windows-v1";
const DISTRIBUTION = "prime-agent-windows";
const PLATFORM = "windows-x64-baseline";
const EXECUTABLE_NAME = "prime-agent.exe";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIRECTORY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const REQUIRED_RELEASE_FILES = [
	"windows-release.json",
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

export interface WindowsRelease {
	directory: string;
	version: string;
	revision: number;
	sha256: string;
}

export interface WindowsInstallation {
	root: string;
	launcher: string;
	executable: string;
	releaseDir: string;
	current: WindowsRelease;
	previous?: WindowsRelease;
	manifestUrl?: string;
}

function isSymlink(path: string): boolean {
	return lstatSync(path).isSymbolicLink();
}

function pathsEqual(a: string, b: string): boolean {
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	} catch {
		return false;
	}
}

function parseRelease(value: unknown): WindowsRelease | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { directory, version, revision, sha256 } = value as Record<string, unknown>;
	if (
		typeof directory !== "string" ||
		!DIRECTORY_PATTERN.test(directory) ||
		directory.includes("..") ||
		basename(directory) !== directory
	)
		return undefined;
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return undefined;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647)
		return undefined;
	if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return undefined;
	return { directory, version, revision, sha256 };
}

function releaseFileIntact(releaseDir: string, relativePath: string): boolean {
	const target = join(releaseDir, ...relativePath.split("/"));
	const stat = lstatSync(target);
	if (!stat.isFile() || stat.isSymbolicLink()) return false;
	if (!pathsEqual(realpathSync(target), target)) return false;
	let parent = dirname(target);
	while (!pathsEqual(parent, releaseDir)) {
		if (isSymlink(parent) || !lstatSync(parent).isDirectory()) return false;
		const next = dirname(parent);
		if (next === parent) return false;
		parent = next;
	}
	return true;
}

function validateRelease(releasesDir: string, record: WindowsRelease): string | undefined {
	try {
		if (!lstatSync(releasesDir).isDirectory() || isSymlink(releasesDir)) return undefined;
		const releaseDir = join(releasesDir, record.directory);
		if (!lstatSync(releaseDir).isDirectory() || isSymlink(releaseDir)) return undefined;
		const resolved = realpathSync(releaseDir);
		if (!pathsEqual(resolved, releaseDir) || !pathsEqual(dirname(resolved), releasesDir)) return undefined;
		const marker = JSON.parse(
			readFileSync(join(releaseDir, "windows-release.json"), "utf8").replace(/^\uFEFF/, ""),
		) as Record<string, unknown>;
		if (typeof marker !== "object" || marker === null) return undefined;
		if (marker?.schema !== 1 || marker.distribution !== DISTRIBUTION || marker.platform !== PLATFORM)
			return undefined;
		if (marker.version !== record.version || marker.revision !== record.revision) return undefined;
		const pkg = JSON.parse(readFileSync(join(releaseDir, "package.json"), "utf8").replace(/^\uFEFF/, "")) as Record<
			string,
			unknown
		>;
		if (pkg?.version !== record.version) return undefined;
		for (const relativePath of [EXECUTABLE_NAME, ...REQUIRED_RELEASE_FILES]) {
			if (!releaseFileIntact(releaseDir, relativePath)) return undefined;
		}
		return releaseDir;
	} catch {
		return undefined;
	}
}

export function readWindowsInstallation(root: string): WindowsInstallation | undefined {
	try {
		root = realpathSync(root);
		const markerPath = join(root, ".windows-managed");
		if (isSymlink(markerPath)) return undefined;
		if (readFileSync(markerPath, "utf8").trim() !== MANAGED_MARKER) return undefined;
		const statePath = join(root, "active.json");
		if (isSymlink(statePath)) return undefined;
		const state = JSON.parse(readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
		if (state?.schema !== 1 || state?.distribution !== DISTRIBUTION) return undefined;
		const current = parseRelease(state.current);
		if (!current) return undefined;
		let previous: WindowsRelease | undefined;
		if (state.previous != null) {
			previous = parseRelease(state.previous);
			if (!previous) return undefined;
		}
		const manifestUrl = state.manifestUrl;
		if (manifestUrl != null && !isHttpsUrl(manifestUrl)) return undefined;
		const releasesDir = join(root, "releases");
		const releaseDir = validateRelease(releasesDir, current);
		if (!releaseDir) return undefined;
		return {
			root,
			launcher: join(root, "prime-agent.cmd"),
			executable: join(releaseDir, EXECUTABLE_NAME),
			releaseDir,
			current,
			...(previous ? { previous } : {}),
			...(manifestUrl ? { manifestUrl } : {}),
		};
	} catch {
		return undefined;
	}
}

export function getWindowsInstallation(executable = process.execPath): WindowsInstallation | undefined {
	try {
		const actual = realpathSync(executable);
		if (basename(actual).toLowerCase() !== EXECUTABLE_NAME) return undefined;
		const root = resolve(dirname(actual), "../..");
		const installation = readWindowsInstallation(root);
		if (!installation) return undefined;
		if (pathsEqual(dirname(actual), installation.releaseDir)) return installation;
		if (installation.previous) {
			const releasesDir = join(installation.root, "releases");
			const previousDir = validateRelease(releasesDir, installation.previous);
			if (previousDir && pathsEqual(dirname(actual), previousDir)) return installation;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
