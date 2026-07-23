/**
 * Processes adapter — JobManager already wraps vendor ProcessManager.
 * Re-export reachability helpers for integration tests.
 */

import { jobManager } from "../runtime/job-manager.ts";
import { ProcessManager } from "../vendor/processes/manager.ts";

export function getProcessManagerClass(): typeof ProcessManager {
	return ProcessManager;
}

export function peekProcessesVendorReachable(): boolean {
	const pm = new ProcessManager();
	return typeof pm.start === "function" && typeof pm.list === "function" && typeof jobManager.start === "function";
}

export { jobManager, ProcessManager };
