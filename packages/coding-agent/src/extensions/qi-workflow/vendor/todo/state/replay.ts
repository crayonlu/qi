// @ts-nocheck
/**
 * Branch replay for vendor TaskState.
 * Last-write-wins across:
 * - todo toolResult.details (upstream rpiv-todo shape)
 * - custom qi-todo-state entries (Qi dashboard/cmd mutations that never emit toolResult)
 */

import type { TaskDetails } from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";

export const QI_TODO_STATE_CUSTOM_TYPE = "qi-todo-state";

export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

function applyDetails(result: TaskState, details: TaskDetails): TaskState {
	return {
		tasks: details.tasks.map((t) => ({ ...t })),
		nextId: details.nextId,
	};
}

/**
 * Walk the current branch chronologically; last matching TaskDetails wins.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type === "custom" && e.customType === QI_TODO_STATE_CUSTOM_TYPE && isTaskDetails(e.data)) {
			result = applyDetails(result, e.data);
			continue;
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		result = applyDetails(result, msg.details);
	}
	return result;
}
