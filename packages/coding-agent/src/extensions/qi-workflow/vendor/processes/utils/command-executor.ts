// Uses node:child_process directly instead of pi.exec() because process
// management requires long-lived streaming processes with stdin/stdout piping
// and detached process groups, which pi.exec() does not support.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const IS_WINDOWS = process.platform === "win32";

interface ResolveShellExecutableOptions {
	configuredShell?: string;
	knownPaths: string[];
}

const DEFAULT_KNOWN_SHELL_PATHS = [
	"/run/current-system/sw/bin/bash",
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
];

function isExistingAbsolutePath(shell: string | undefined): shell is string {
	return typeof shell === "string" && isAbsolute(shell) && existsSync(shell);
}

export function resolveShellExecutable({ configuredShell, knownPaths }: ResolveShellExecutableOptions): string {
	// A user-configured absolute path always wins on every platform.
	if (isExistingAbsolutePath(configuredShell)) {
		return configuredShell;
	}

	// On Windows we assume Git Bash is running, so `bash` is on PATH.
	// No absolute-path probing is needed or possible with POSIX-style paths.
	if (IS_WINDOWS) {
		return "bash";
	}

	for (const path of knownPaths) {
		if (isExistingAbsolutePath(path)) {
			return path;
		}
	}

	throw new Error("Unable to resolve shell executable. Checked configured shell and known shell paths.");
}

export function spawnCommand(command: string, cwd: string, configuredShell?: string): ChildProcess {
	const shellExecutable = resolveShellExecutable({
		configuredShell,
		knownPaths: DEFAULT_KNOWN_SHELL_PATHS,
	});

	return spawn(shellExecutable, ["-lc", command], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
		// Suppress the console window that `detached: true` would otherwise open
		// on Windows. Has no effect on Unix.
		windowsHide: true,
	});
}
