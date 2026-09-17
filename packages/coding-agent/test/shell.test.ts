import type * as NodeFs from "node:fs";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";
import { createLocalBashOperations } from "../src/core/tools/bash.js";
import {
	getShellCommandArgs,
	getShellConfig,
	getWindowsPowerShell,
	resolveKernelBashShell,
	type ShellConfig,
} from "../src/utils/shell.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const existsSyncMock = vi.mocked(existsSync);
const realExistsSync = existsSyncMock.getMockImplementation()!;

const isWindows = process.platform === "win32";

const WINDOWS_POWERSHELL = win32.join(
	process.env.SystemRoot ?? "C:\\Windows",
	"System32",
	"WindowsPowerShell",
	"v1.0",
	"powershell.exe",
);
const WINDOWS_PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function stubPlatform(platform: NodeJS.Platform): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform });
	return () => {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
	};
}

async function execCommand(
	command: string,
	cwd: string,
	options?: { shellPath?: string; signal?: AbortSignal },
): Promise<{ exitCode: number | null; output: string }> {
	let output = "";
	const result = await createLocalBashOperations({ shellPath: options?.shellPath }).exec(command, cwd, {
		onData: (data) => {
			output += data.toString("utf8");
		},
		signal: options?.signal,
	});
	return { exitCode: result.exitCode, output };
}

describe("shell command construction", () => {
	afterEach(() => {
		existsSyncMock.mockImplementation(realExistsSync);
	});

	it("maps powershell-family executables to -EncodedCommand args", () => {
		existsSyncMock.mockReturnValue(true);
		for (const shell of ["pwsh", "pwsh.exe", "powershell", "powershell.exe", "C:\\tools\\PWSH.EXE"]) {
			expect(getShellConfig(shell).args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
		}
		expect(getShellConfig("C:\\Windows\\System32\\cmd.exe").args).toEqual(["/d", "/s", "/c"]);
		expect(getShellConfig("/bin/bash").args).toEqual(["-c"]);
	});

	it("encodes the command as a UTF-16LE base64 wrapper for powershell", () => {
		const config: ShellConfig = {
			shell: "powershell.exe",
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"],
		};
		const args = getShellCommandArgs(config, "Write-Output 'encoded'");
		expect(args.slice(0, -1)).toEqual(config.args);
		const script = Buffer.from(args[args.length - 1]!, "base64").toString("utf16le");
		expect(script).toContain("$ErrorActionPreference = 'Stop'");
		expect(script).toContain("[Console]::OutputEncoding = $utf8");
		expect(script).toContain("Write-Output 'encoded'");
		expect(script).toContain("exit $LASTEXITCODE");
	});

	it("passes the command verbatim for cmd and POSIX shells", () => {
		expect(getShellCommandArgs({ shell: "cmd.exe", args: ["/d", "/s", "/c"] }, "dir")).toEqual([
			"/d",
			"/s",
			"/c",
			"dir",
		]);
		expect(getShellCommandArgs({ shell: "/bin/sh", args: ["-c"] }, "echo hi")).toEqual(["-c", "echo hi"]);
	});
});

describe("Windows shell selection", () => {
	afterEach(() => {
		existsSyncMock.mockImplementation(realExistsSync);
	});

	it("selects in-box Windows PowerShell without consulting PATH", () => {
		const restore = stubPlatform("win32");
		const seen: string[] = [];
		try {
			existsSyncMock.mockImplementation((candidate) => {
				seen.push(String(candidate));
				return String(candidate) === WINDOWS_POWERSHELL;
			});
			const config = getShellConfig();
			expect(config.shell).toBe(WINDOWS_POWERSHELL);
			expect(config.args).toContain("-EncodedCommand");
			expect(seen.every((entry) => entry === WINDOWS_PWSH || entry === WINDOWS_POWERSHELL)).toBe(true);
		} finally {
			restore();
		}
	});

	it("prefers an installed PowerShell 7 over in-box powershell.exe", () => {
		const restore = stubPlatform("win32");
		try {
			existsSyncMock.mockReturnValue(true);
			expect(getWindowsPowerShell()).toBe(WINDOWS_PWSH);
			expect(resolveKernelBashShell()).toBe(WINDOWS_PWSH);
		} finally {
			restore();
		}
	});

	it("honors an explicit shellPath before native discovery", () => {
		const restore = stubPlatform("win32");
		try {
			existsSyncMock.mockReturnValue(true);
			expect(getShellConfig("D:\\tools\\pwsh.exe")).toEqual({
				shell: "D:\\tools\\pwsh.exe",
				args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"],
			});
			expect(resolveKernelBashShell("D:\\tools\\custom-shell")).toBe("D:\\tools\\custom-shell");
		} finally {
			restore();
		}
	});

	it("fails with install guidance when no native PowerShell exists", () => {
		const restore = stubPlatform("win32");
		try {
			existsSyncMock.mockReturnValue(false);
			expect(() => getShellConfig()).toThrow(/PowerShell/);
			expect(() => resolveKernelBashShell()).toThrow(/PowerShell/);
		} finally {
			restore();
		}
	});

	it("rejects a custom shellPath that does not exist", () => {
		existsSyncMock.mockReturnValue(false);
		expect(() => getShellConfig(join("missing", "shell.exe"))).toThrow(/not found/);
	});
});

describe("local shell execution", () => {
	it("runs a command through the platform default shell", async () => {
		const command = isWindows ? "Write-Output 'native-shell'" : "printf '%s\\n' 'native-shell'";
		const result = await execCommand(command, process.cwd());
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("native-shell");
	});

	it.each([0, 7])("propagates the exact exit code %i", async (code) => {
		const result = await execCommand(`exit ${code}`, process.cwd());
		expect(result.exitCode).toBe(code);
	});

	it("propagates a native executable's nonzero exit code", async () => {
		const cmdExe = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
		const command = isWindows ? `& '${cmdExe}' /d /c 'exit 23'` : "/bin/sh -c 'exit 23'";
		const result = await execCommand(command, process.cwd());
		expect(result.exitCode).toBe(23);
	});

	it("returns a non-zero exit for a missing command", async () => {
		const command = isWindows ? "Get-PrimeAgentCommandThatDoesNotExist" : "prime-agent-command-that-does-not-exist";
		const result = await execCommand(command, process.cwd());
		expect(result.exitCode).not.toBe(0);
	});

	it("passes shell metacharacters and Unicode through to the command", async () => {
		const unicodeText = String.fromCodePoint(0x4e2d, 0x6587, 0xe9);
		const expected = `$dollar 'apos' & %percent "quote" ${unicodeText}`;
		const command = isWindows
			? "Write-Output ('$dollar ''apos'' & %percent \"quote\" ' + [char]0x4E2D + [char]0x6587 + [char]0x00E9)"
			: `printf '%s\\n' '$dollar '\\''apos'\\'' & %percent "quote" ${unicodeText}'`;
		const result = await execCommand(command, process.cwd());
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(expected);
	});

	it("runs in a working directory containing spaces and Unicode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime shell ünïcodë "));
		try {
			const command = isWindows ? "(Get-Location).Path" : "pwd -P";
			const result = await execCommand(command, dir);
			expect(result.exitCode).toBe(0);
			const expected = statSync(dir, { bigint: true });
			expect(statSync(result.output.trim(), { bigint: true })).toMatchObject({
				dev: expected.dev,
				ino: expected.ino,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes through an explicit shellPath", async () => {
		const shellPath = isWindows ? WINDOWS_POWERSHELL : "/bin/sh";
		const command = isWindows ? "Write-Output 'explicit-shell'" : "printf '%s\\n' 'explicit-shell'";
		const result = await execCommand(command, process.cwd(), { shellPath });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("explicit-shell");
	});

	it("rejects a pre-aborted exec without spawning a child", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime abort "));
		const journal = join(dir, "orphan-journal.log");
		const marker = join(dir, "should-not-exist");
		const previousJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
		const controller = new AbortController();
		controller.abort();
		try {
			const command = isWindows
				? `New-Item -Path '${marker.replaceAll("'", "''")}' -ItemType File`
				: `touch '${marker.replaceAll("'", "'\\''")}'`;
			await expect(execCommand(command, dir, { signal: controller.signal })).rejects.toThrow(/abort/i);
			expect(existsSync(journal)).toBe(false);
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (previousJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = previousJournal;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
