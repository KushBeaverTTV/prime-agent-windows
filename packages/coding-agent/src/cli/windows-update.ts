import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, type SelfUpdateCommand } from "../config.js";
import { getWindowsPowerShell } from "../utils/shell.js";
import { isBaseVersionDowngrade, type UpdateChannel } from "../utils/version-check.js";
import { getWindowsInstallation } from "../utils/windows-installation.js";
import type { NativeUpdatePlan } from "./native-update.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ARCHIVE_FILE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*\.zip$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;

interface WindowsUpdateManifest {
	schema: 1;
	distribution: "prime-agent-windows";
	platform: "windows-x64-baseline";
	version: string;
	revision: number;
	file: string;
	sha256: string;
}

function assertHttpsUrl(url: URL, what: string): void {
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(`${what} must be an HTTPS URL without credentials.`);
	}
}

async function readCappedBody(response: Response): Promise<string> {
	const body = response.body;
	if (!body) return response.text();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_MANIFEST_BYTES) {
				throw new Error("The Windows update manifest exceeds the 64KiB limit.");
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function parseWindowsUpdateManifest(text: string): WindowsUpdateManifest {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("The Windows update manifest is not valid JSON.");
	}
	const manifest = data as Record<string, unknown>;
	if (manifest?.schema !== 1 || manifest.distribution !== "prime-agent-windows") {
		throw new Error("The Windows update manifest has an unexpected schema or distribution.");
	}
	if (manifest.platform !== "windows-x64-baseline") {
		throw new Error("The Windows update manifest targets an unsupported platform.");
	}
	if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) {
		throw new Error("The Windows update manifest has an invalid version.");
	}
	if (
		typeof manifest.revision !== "number" ||
		!Number.isSafeInteger(manifest.revision) ||
		manifest.revision < 1 ||
		manifest.revision > 2_147_483_647
	) {
		throw new Error("The Windows update manifest has an invalid revision.");
	}
	if (typeof manifest.file !== "string" || !ARCHIVE_FILE_PATTERN.test(manifest.file) || manifest.file.includes("%")) {
		throw new Error("The Windows update manifest has an invalid archive file name.");
	}
	if (typeof manifest.sha256 !== "string" || !SHA256_PATTERN.test(manifest.sha256)) {
		throw new Error("The Windows update manifest has an invalid checksum.");
	}
	return manifest as unknown as WindowsUpdateManifest;
}

async function fetchWindowsUpdateManifest(manifestUrl: string): Promise<WindowsUpdateManifest> {
	let url = new URL(manifestUrl);
	for (let hop = 0; ; hop++) {
		assertHttpsUrl(url, "The Windows update manifest URL");
		const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30000) });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (hop >= MAX_REDIRECTS) {
				throw new Error("The Windows update manifest exceeded the redirect limit.");
			}
			if (!location) {
				throw new Error("The Windows update manifest redirect had no Location header.");
			}
			url = new URL(location, url);
			continue;
		}
		if (!response.ok) {
			const status = response.status;
			await response.body?.cancel();
			throw new Error(`The Windows update manifest request failed with HTTP ${status}.`);
		}
		return parseWindowsUpdateManifest(await readCappedBody(response));
	}
}

export async function getWindowsUpdatePlan(options: {
	force: boolean;
	rollback: boolean;
	channel?: UpdateChannel;
	executable?: string;
}): Promise<NativeUpdatePlan> {
	const installation = getWindowsInstallation(options.executable);
	if (!installation) {
		throw new Error("This Windows build must be updated using install-windows.ps1.");
	}
	if (options.channel === "nightly") {
		throw new Error(
			"Windows builds only support the stable update channel; nightly releases are not published for Windows.",
		);
	}
	const powershell = getWindowsPowerShell();
	const installer = join(installation.releaseDir, "install-windows.ps1");
	if (options.rollback) {
		const previous = installation.previous;
		if (!previous) {
			throw new Error("No previous Windows release is available to roll back to.");
		}
		const previousDir = join(installation.root, "releases", previous.directory);
		if (
			!existsSync(previousDir) ||
			lstatSync(previousDir).isSymbolicLink() ||
			!existsSync(join(previousDir, "windows-release.json"))
		) {
			throw new Error(
				`The recorded previous Windows release ${previous.version} is missing or damaged; cannot roll back.`,
			);
		}
		return {
			targetVersion: previous.version,
			command: {
				command: powershell,
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-File",
					installer,
					"-Rollback",
					"-InstallDir",
					installation.root,
					"-ExpectedCurrent",
					installation.current.directory,
				],
				display: `${APP_NAME} update --rollback`,
			},
		};
	}
	const manifestUrl = installation.manifestUrl;
	if (!manifestUrl) {
		throw new Error(
			"No Windows update channel configured; install with -ManifestUrl pointing to your Windows fork release manifest. Upstream Linux/macOS releases are not compatible.",
		);
	}
	const manifest = await fetchWindowsUpdateManifest(manifestUrl);
	if (isBaseVersionDowngrade(manifest.version, installation.current.version)) {
		return { targetVersion: installation.current.version, refusedDowngradeTo: manifest.version };
	}
	const sameVersion = manifest.version === installation.current.version;
	if (sameVersion && manifest.revision < installation.current.revision) {
		return { targetVersion: installation.current.version, refusedDowngradeTo: manifest.version };
	}
	if (sameVersion && manifest.revision === installation.current.revision && !options.force) {
		return { targetVersion: installation.current.version };
	}
	const archiveUrl = new URL(manifest.file, manifestUrl);
	assertHttpsUrl(archiveUrl, "The Windows release archive URL");
	const command: SelfUpdateCommand = {
		command: powershell,
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-File",
			installer,
			"-ArchiveUrl",
			archiveUrl.toString(),
			"-ExpectedSha256",
			manifest.sha256,
			"-InstallDir",
			installation.root,
			"-ManifestUrl",
			manifestUrl,
			"-ExpectedCurrent",
			installation.current.directory,
			"-ExpectedVersion",
			manifest.version,
			"-ExpectedRevision",
			String(manifest.revision),
			...(options.force ? ["-Force"] : []),
		],
		display: `${APP_NAME} update${options.force ? " --force" : ""}`,
	};
	return { targetVersion: manifest.version, command };
}
