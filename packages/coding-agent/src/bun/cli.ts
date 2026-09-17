#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { APP_NAME } from "../config.js";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.js";

restoreSandboxEnv();

if (process.platform === "win32" && process.argv.includes("--windows-runtime-probe")) {
	const require = createRequire(join(dirname(process.execPath), "package.json"));
	const koffi = require("./native/koffi");
	const kernel32 = koffi.load("kernel32.dll");
	const getCurrentProcessId = kernel32.func("uint32_t __stdcall GetCurrentProcessId()");
	if (getCurrentProcessId() !== process.pid) throw new Error("Windows native module probe failed");
	console.log("windows-runtime-ok");
} else {
	await import("./register-bedrock.js");
	await import("../cli.js");
}
