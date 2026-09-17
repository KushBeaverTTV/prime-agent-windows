import { existsSync } from "node:fs";
import { basename, delimiter, win32 } from "node:path";
import { getBinDir } from "../config.js";
import { recordOrphanProcessState } from "../core/orphan-process-journal.js";
import { spawnHidden, spawnSyncHidden } from "./child-process.js";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * Find bash executable on PATH (POSIX only; Windows never reaches this —
 * win32 returns the native PowerShell config before this call site).
 */
function findBashOnPath(): string | null {
	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSyncHidden("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

// Hardcoded literals: ProgramFiles env vars are ambient attacker-influenceable
// input, the same trust-laundering class as PATH.
export function getWindowsPowerShell(): string {
	const candidates = [
		// 2. Prefer native PowerShell 7.
		"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
		// 3. Fall back to in-box Windows PowerShell.
		win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	];
	const executable = candidates.find((candidate) => existsSync(candidate));
	if (!executable) {
		throw new Error("Native PowerShell was not found. Install PowerShell or configure an absolute shellPath.");
	}
	return executable;
}

function shellConfig(shell: string): ShellConfig {
	const name = basename(shell.replaceAll("\\", "/"));
	if (/^(?:pwsh|powershell)(?:\.exe)?$/i.test(name)) {
		return { shell, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"] };
	}
	if (/^cmd(?:\.exe)?$/i.test(name)) {
		return { shell, args: ["/d", "/s", "/c"] };
	}
	return { shell, args: ["-c"] };
}

export function getShellCommandArgs(config: ShellConfig, command: string): string[] {
	if (!config.args.includes("-EncodedCommand")) return [...config.args, command];
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		"$utf8 = New-Object System.Text.UTF8Encoding($false)",
		"[Console]::InputEncoding = $utf8",
		"[Console]::OutputEncoding = $utf8",
		"$OutputEncoding = $utf8",
		"$global:LASTEXITCODE = 0",
		"try {",
		"& {",
		command,
		"}",
		"$primeAgentSucceeded = $?",
		"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
		"if (-not $primeAgentSucceeded) { exit 1 }",
		"exit 0",
		"} catch {",
		"[Console]::Error.WriteLine($_.ToString())",
		"exit 1",
		"}",
	].join("\n");
	return [...config.args, Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: native PowerShell (pwsh, else in-box powershell.exe)
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return shellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		return shellConfig(getWindowsPowerShell());
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

/**
 * Absolute default shell for the kernel's bash(): explicit shellPath wins; POSIX
 * uses /bin/bash else /bin/sh (absolute, never PATH — the kernel inherits a
 * user-influenced PATH); win32 uses only the native PowerShell install paths,
 * never PATH (a repo-controlled PATH/where.exe must not pick the kernel shell).
 * A missing PowerShell throws rather than degrading to undefined — Windows
 * PowerShell ships with the OS, so its absence is a real configuration error.
 */
export function resolveKernelBashShell(customShellPath?: string): string | undefined {
	const explicit = customShellPath?.trim();
	if (explicit) {
		return explicit;
	}
	if (process.platform !== "win32") {
		return existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	}
	return getWindowsPowerShell();
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	// Agent-spawned shells never have a usable stdin (stdio: ["ignore", "pipe", "pipe"]),
	// so any interactive prompt opened via /dev/tty is a guaranteed hang until killed:
	// `git commit` without -m launches $EDITOR, credential helpers block waiting for a
	// password, pagers read the terminal directly. Make those cases fail fast or no-op
	// instead of hanging.
	//
	// These deliberately override inherited terminal settings (an EDITOR=vim inherited
	// from the launching shell is exactly the hang we are preventing, and stdin is
	// ignored even for user `!` commands, so an interactive editor can never receive
	// keystrokes anyway). A user who wants a prompt in a specific command can override
	// inline (`GIT_EDITOR=vim git commit`), which takes precedence over exported vars.
	const isWindows = process.platform === "win32";
	const windowsFailFast = `"${win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe").replaceAll("\\", "/")}" /d /c exit 1`;
	return {
		...process.env,
		[pathKey]: updatedPath,
		GIT_EDITOR: isWindows ? windowsFailFast : "true",
		GIT_SEQUENCE_EDITOR: isWindows ? windowsFailFast : "true",
		GIT_TERMINAL_PROMPTS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: isWindows ? windowsFailFast : "true",
		SSH_ASKPASS_REQUIRE: "never",
		EDITOR: isWindows ? windowsFailFast : "true",
		VISUAL: isWindows ? windowsFailFast : "true",
		PAGER: isWindows ? "" : "cat",
		GIT_PAGER: isWindows ? "" : "cat",
		DEBIAN_FRONTEND: "noninteractive",
		...(isWindows ? { PYTHONUTF8: "1", NoDefaultCurrentDirectoryInExePath: "1" } : {}),
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
	recordOrphanProcessState(pid, true);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	recordOrphanProcessState(pid, false);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
		recordOrphanProcessState(pid, false);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawnHidden(
				win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
				},
			);
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
