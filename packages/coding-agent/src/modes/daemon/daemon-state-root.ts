import { dirname, resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "./daemon-socket.js";
import { listDaemonSupervisorSocketPathsForAgentDir } from "./daemon-supervisor-ownership.js";

/**
 * The state root an invocation reads and writes: the agent dir (config, logs,
 * worker descriptors) and the default daemon socket dir. Both already follow
 * HOME, TMPDIR and the agent-dir env override, so an isolated root resolves to
 * isolated paths; this type just carries the pair around so daemon discovery can
 * be scoped the same way instead of sweeping the whole machine.
 */
export interface DaemonStateRoot {
	agentDir: string;
	socketDir: string;
	defaultSocketPath: string;
}

export function currentDaemonStateRoot(): DaemonStateRoot {
	return {
		agentDir: getAgentDir(),
		socketDir: defaultDaemonSocketDir(),
		defaultSocketPath: normalizeSocketPath(defaultDaemonSocketPath()),
	};
}

/**
 * Predicate for "this daemon belongs to our state root". A daemon is ours when
 * its socket sits in our socket dir, or when the supervisor ownership registry
 * (itself scoped to our HOME) records it under our agent dir — that second rule
 * keeps daemons on custom `--daemon-socket` paths in scope for the root that
 * started them.
 *
 * The registry read is deferred and memoised so the common case (every socket in
 * our own socket dir) costs nothing, and a fresh matcher per sweep keeps results
 * current for callers that poll.
 */
export function createDaemonStateRootMatcher(
	root: DaemonStateRoot = currentDaemonStateRoot(),
): (socketPath: string) => boolean {
	if (process.platform === "win32") {
		// Windows daemons share one named pipe per machine, so there is nothing to scope.
		return () => true;
	}
	const socketDir = resolve(root.socketDir);
	let registeredSocketPaths: Set<string> | undefined;
	return (socketPath: string): boolean => {
		const normalized = normalizeSocketPath(socketPath);
		if (normalized === root.defaultSocketPath || resolve(dirname(normalized)) === socketDir) {
			return true;
		}
		registeredSocketPaths ??= new Set(listDaemonSupervisorSocketPathsForAgentDir(root.agentDir));
		return registeredSocketPaths.has(normalized);
	};
}
