import type { SessionManager } from "../../../core/session-manager.ts";
import {
	createEmptyState,
	QI_STATE_CUSTOM_TYPE,
	type QiWorkflowState,
	recoverJobStatuses,
	recoverTaskStatuses,
	recoverWorkflowStatuses,
} from "../domain/index.ts";

export function serializeState(state: QiWorkflowState): QiWorkflowState {
	// Persist a plain JSON-safe snapshot (no live handles).
	return structuredClone(state);
}

export function loadStateFromSession(sessionManager: SessionManager, sessionId: string): QiWorkflowState {
	let latest: QiWorkflowState | undefined;
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== QI_STATE_CUSTOM_TYPE) continue;
		latest = entry.data as QiWorkflowState;
	}
	if (!latest || latest.sessionId !== sessionId) {
		return createEmptyState(sessionId);
	}
	return sanitizeRestoredState(latest);
}

/** Restart recovery: never report terminal interrupted work as still running. */
export function sanitizeRestoredState(state: QiWorkflowState): QiWorkflowState {
	let next = state;
	const tasks = recoverTaskStatuses(next);
	next = tasks.state;
	const workflows = recoverWorkflowStatuses(next);
	next = workflows.state;
	const jobs = recoverJobStatuses(next);
	next = jobs.state;
	// Open question survives restore; btw draft survives but is not auto-shown.
	return next;
}

export function persistState(appendEntry: (customType: string, data?: unknown) => void, state: QiWorkflowState): void {
	appendEntry(QI_STATE_CUSTOM_TYPE, serializeState(state));
}
