#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePlatforms, windowsReleasePlatforms } from "../../../scripts/release-platforms.mjs";
import { writeClipboardBinaryBinding } from "./clipboard-binary-binding.mjs";
import {
	copyBinaryAssets,
	packWindowsKoffiAssets,
	validateBinaryAssets,
	validateWindowsKoffiAssets,
} from "./copy-binary-assets.mjs";
import { signMacosBinary } from "./macos-signature.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageDir = join(root, "packages/coding-agent");
const platforms = [...releasePlatforms, ...windowsReleasePlatforms];
const args = process.argv.slice(2);
const defaultPlatform =
	process.platform === "win32"
		? process.arch === "x64"
			? "windows-x64-baseline"
			: null
		: `${process.platform}-${process.arch}`;
const platform = args.length === 0 ? defaultPlatform : args[1];
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--platform")) {
	throw new Error(`Usage: npm run build:binary -- [--platform ${[...platforms, "all"].join("|")}]`);
}
if (platform === null) throw new Error(`Unsupported Windows architecture for a local binary build: ${process.arch}`);
if (platform !== "all" && !platforms.includes(platform)) throw new Error(`Unsupported binary platform: ${platform}`);

const WINDOWS_BUN_TOOLING_DIR = join(
	process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? root, "AppData", "Local"),
	"prime-agent-tooling",
	"bun-1.4.0",
);

function bunVersionOf(executable) {
	try {
		return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

function runWindowsCommand(commandLine, options = {}) {
	const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
	return execFileSync(cmd, ["/d", "/s", "/c", `"${commandLine}"`], {
		windowsVerbatimArguments: true,
		...options,
	});
}

function resolveWindowsNpm() {
	const candidate = join(dirname(process.execPath), "npm.cmd");
	if (!existsSync(candidate)) {
		throw new Error(`npm is required to provision the pinned Bun compiler; not found next to Node at ${candidate}`);
	}
	return candidate;
}

function provisionWindowsBun() {
	const candidates = [
		join(WINDOWS_BUN_TOOLING_DIR, "node_modules", "bun", "bin", "bun.exe"),
		join(WINDOWS_BUN_TOOLING_DIR, "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe"),
	];
	const existing = candidates.find((candidate) => bunVersionOf(candidate) === "1.4.0");
	if (existing) return existing;
	const npm = resolveWindowsNpm();
	const metadata = JSON.parse(
		runWindowsCommand(`"${npm}" view bun@1.4.0 time --json`, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}),
	);
	const published = Date.parse(metadata?.time?.["1.4.0"] ?? metadata?.["1.4.0"] ?? "");
	if (!Number.isFinite(published) || Date.now() - published < 7 * 24 * 60 * 60 * 1000) {
		throw new Error("Pinned Bun 1.4.0 is younger than the 7-day minimum release age; refusing to install.");
	}
	mkdirSync(WINDOWS_BUN_TOOLING_DIR, { recursive: true });
	const toolingManifest = join(WINDOWS_BUN_TOOLING_DIR, "package.json");
	if (existsSync(toolingManifest)) {
		const existing = JSON.parse(readFileSync(toolingManifest, "utf8"));
		if (existing?.name !== "prime-agent-tooling" || existing?.private !== true) {
			throw new Error(`Refusing to reuse unmanaged tooling directory: ${WINDOWS_BUN_TOOLING_DIR}`);
		}
	} else {
		writeFileSync(toolingManifest, '{"name":"prime-agent-tooling","private":true}\n');
	}
	runWindowsCommand(
		`"${npm}" install bun@1.4.0 --min-release-age=7 --ignore-scripts --no-audit --no-fund --loglevel=error`,
		{ cwd: WINDOWS_BUN_TOOLING_DIR, stdio: "inherit" },
	);
	return candidates.find((candidate) => bunVersionOf(candidate) === "1.4.0");
}

function resolveBun() {
	if (process.env.BUN_BINARY) {
		const version = bunVersionOf(process.env.BUN_BINARY);
		if (version !== "1.4.0") throw new Error(`Binary compilation requires Bun 1.4.0; found ${version}`);
		return process.env.BUN_BINARY;
	}
	if (bunVersionOf("bun") === "1.4.0") return "bun";
	if (process.platform === "win32") {
		const provisioned = provisionWindowsBun();
		if (provisioned) return provisioned;
	}
	throw new Error("Binary compilation requires Bun 1.4.0 and no pinned compiler is available.");
}

const bun = resolveBun();

// Emit workspace JavaScript and declarations using the committed model catalog.
for (const name of ["tui", "ai", "agent", "coding-agent"]) {
	if (process.platform === "win32") {
		const tsgo = join(root, "node_modules", ".bin", "tsgo.cmd");
		runWindowsCommand(`"${tsgo}" -p "packages\\${name}\\tsconfig.build.json"`, { cwd: root, stdio: "inherit" });
	} else {
		execFileSync(join(root, "node_modules/.bin/tsgo"), ["-p", `packages/${name}/tsconfig.build.json`], {
			cwd: root,
			stdio: "inherit",
		});
	}
}

const buildId = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const outputRoot = join(packageDir, "binaries");
mkdirSync(outputRoot, { recursive: true });
for (const target of platform === "all" ? releasePlatforms : [platform]) {
	const staging = mkdtempSync(join(outputRoot, ".build-"));
	const outputName = target.startsWith("windows-") ? "prime-agent.exe" : "prime-agent";
	try {
		writeClipboardBinaryBinding(join(packageDir, "dist/utils/clipboard-binary-binding.js"), target);
		execFileSync(
			bun,
			[
				"build",
				"--compile",
				"--minify",
				"--keep-names",
				"--bytecode",
				"--format=esm",
				"--external",
				"koffi",
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				"--define",
				`__PI_BUILD_ID__=${JSON.stringify(buildId)}`,
				`--target=bun-${target}`,
				"./dist/bun/cli.js",
				"--outfile",
				join(staging, outputName),
			],
			{ cwd: packageDir, stdio: "inherit" },
		);
		signMacosBinary(join(staging, outputName), target);
		copyBinaryAssets(staging);
		validateBinaryAssets(staging);
		if (target.startsWith("windows-")) {
			packWindowsKoffiAssets(staging);
			validateWindowsKoffiAssets(staging);
		}
		const destination = join(outputRoot, target);
		rmSync(destination, { recursive: true, force: true });
		renameSync(staging, destination);
		console.log(`Created ${destination}`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
