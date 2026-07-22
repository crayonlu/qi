import { execSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Check if a process (group) is still alive.
 * On Unix: uses signal 0 sent to the process group (negative pgid).
 * On Windows (Git Bash): uses signal 0 sent to the positive PID —
 *   process groups are not supported by Node.js on win32.
 */
export function isProcessGroupAlive(pgid: number): boolean {
	try {
		if (IS_WINDOWS) {
			process.kill(pgid, 0);
		} else {
			process.kill(-pgid, 0);
		}
		return true;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		// EPERM: process exists but we can't signal it — treat as alive.
		return err.code === "EPERM";
	}
}

/**
 * Terminate a process (and its children) by pgid.
 * On Unix: sends the given signal to the entire process group.
 * On Windows (Git Bash): uses `taskkill /F /T /PID` to force-kill the
 *   process tree — the signal argument is ignored on Windows.
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
	if (IS_WINDOWS) {
		try {
			execSync(`taskkill /F /T /PID ${pgid}`, { stdio: "ignore" });
		} catch {
			// Process may already be gone — ignore.
		}
	} else {
		process.kill(-pgid, signal);
	}
}
