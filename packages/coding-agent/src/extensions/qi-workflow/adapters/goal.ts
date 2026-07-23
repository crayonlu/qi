/**
 * Thin Qi adapter over adopted pi-goal runtime helpers.
 * Prefer GoalRuntime (runtime/goal-lifecycle.ts) as source of truth;
 * these helpers project ActiveGoal ↔ Qi Goal without zeroing accounting.
 */

import { nowMs } from "../domain/ids.ts";
import type { TransitionResult } from "../domain/result.ts";
import type { Goal, GoalStatus, QiWorkflowState } from "../domain/types.ts";
import { getGoalRuntime } from "../runtime/goal-lifecycle.ts";
import type { ActiveGoal } from "../vendor/goal/persistence.ts";
import {
	goalIdRejectionReason,
	isContradictoryCompletionSummary,
	createGoal as vendorCreateGoal,
	transitionGoal as vendorTransitionGoal,
} from "../vendor/goal/runtime.ts";

function fail<T>(state: QiWorkflowState, error: string): TransitionResult<T> {
	return { ok: false, error, state };
}

function ok<T>(state: QiWorkflowState, value: T): TransitionResult<T> {
	return { ok: true, value, state };
}

function toQiStatus(status: ActiveGoal["status"]): GoalStatus {
	if (status === "paused") return "paused";
	if (status === "blocked" || status === "budget_limited" || status === "usage_limited") return "blocked";
	if (status === "complete") return "completed";
	if (status === "queued") return "paused";
	return "active";
}

/** Round-trip Qi Goal → ActiveGoal preserving accounting fields. */
export function asActive(goal: Goal, status?: ActiveGoal["status"]): ActiveGoal {
	const vendorStatus = (status ??
		(goal.vendorStatus as ActiveGoal["status"] | undefined) ??
		(goal.status === "completed"
			? "complete"
			: goal.status === "cancelled"
				? "paused"
				: goal.status === "blocked"
					? "blocked"
					: goal.status === "paused"
						? "paused"
						: "active")) as ActiveGoal["status"];
	return {
		id: goal.id,
		text: goal.objective,
		status: vendorStatus,
		startedAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		iteration: goal.iteration,
		tokenBudget: goal.tokenBudget,
		tokensUsed: goal.tokensUsed ?? 0,
		timeUsedSeconds: goal.timeUsedSeconds ?? 0,
		baselineTokens: goal.baselineTokens ?? 0,
		activeStartedAt: goal.activeStartedAt,
	};
}

export function projectGoal(active: ActiveGoal, previous?: Goal | null): Goal {
	const t = nowMs();
	return {
		id: active.id,
		objective: active.text,
		summary: active.text,
		status: toQiStatus(active.status),
		todoIds: previous?.todoIds ?? [],
		createdAt: previous?.createdAt ?? active.startedAt ?? t,
		updatedAt: active.updatedAt,
		revision: (previous?.revision ?? 0) + 1,
		iteration: active.iteration,
		tokenBudget: active.tokenBudget,
		tokensUsed: active.tokensUsed,
		timeUsedSeconds: active.timeUsedSeconds,
		baselineTokens: active.baselineTokens,
		activeStartedAt: active.activeStartedAt,
		vendorStatus: active.status,
		blockReason: previous?.blockReason,
		completionEvidence: previous?.completionEvidence,
		continuationTicket: previous?.continuationTicket,
	};
}

export function setGoalViaVendor(
	state: QiWorkflowState,
	objective: string,
	tokenBudget?: number,
): TransitionResult<Goal> {
	const trimmed = objective.trim();
	if (!trimmed) return fail(state, "Goal objective is required");
	const active = vendorCreateGoal(trimmed, tokenBudget, 0);
	const runtime = getGoalRuntime();
	if (runtime) {
		runtime.activeGoal = active;
		runtime.persistGoal(active);
		const projected = projectGoal(active);
		return ok(
			{ ...state, goal: projected, todos: state.todos.filter((t) => t.goalId !== state.goal?.id) },
			projected,
		);
	}
	const goal = projectGoal(active);
	return ok(
		{
			...state,
			goal,
			todos: state.todos.filter((todo) => todo.goalId !== state.goal?.id),
		},
		goal,
	);
}

export function pauseGoalViaVendor(state: QiWorkflowState): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	if (state.goal.status !== "active") return fail(state, `Cannot pause goal in status ${state.goal.status}`);
	const next = vendorTransitionGoal(asActive(state.goal, "active"), "paused");
	const runtime = getGoalRuntime();
	if (runtime) {
		runtime.activeGoal = next;
		runtime.persistGoal(next);
	}
	const goal = projectGoal(next, state.goal);
	goal.continuationTicket = undefined;
	return ok({ ...state, goal }, goal);
}

export function resumeGoalViaVendor(state: QiWorkflowState): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	if (state.goal.status !== "paused" && state.goal.status !== "blocked") {
		return fail(state, `Cannot resume goal in status ${state.goal.status}`);
	}
	const vendorStatus =
		(state.goal.vendorStatus as ActiveGoal["status"] | undefined) ??
		(state.goal.status === "blocked" ? "blocked" : "paused");
	const next = vendorTransitionGoal(asActive(state.goal, vendorStatus), "active");
	const runtime = getGoalRuntime();
	if (runtime) {
		runtime.activeGoal = next;
		runtime.persistGoal(next);
	}
	const goal = projectGoal(next, state.goal);
	goal.blockReason = undefined;
	return ok({ ...state, goal }, goal);
}

export function completeGoalViaVendor(
	state: QiWorkflowState,
	evidence: string,
	goalId: string,
): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	const rejection = goalIdRejectionReason(asActive(state.goal), goalId);
	if (rejection) return fail(state, rejection);
	if (isContradictoryCompletionSummary(evidence)) {
		return fail(state, "Completion evidence contradicts a finished objective");
	}
	const next = vendorTransitionGoal(asActive(state.goal, "active"), "complete");
	const runtime = getGoalRuntime();
	if (runtime) {
		runtime.activeGoal = next;
		runtime.setCompletionSummary(next.id, evidence.trim());
		runtime.persistGoal(next);
	}
	const goal = projectGoal(next, state.goal);
	goal.completionEvidence = evidence.trim();
	goal.continuationTicket = undefined;
	return ok({ ...state, goal }, goal);
}

export function blockGoalViaVendor(state: QiWorkflowState, reason: string, goalId: string): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	const rejection = goalIdRejectionReason(asActive(state.goal), goalId);
	if (rejection) return fail(state, rejection);
	const trimmed = reason.trim();
	if (!trimmed) return fail(state, "Block reason is required");
	const next = vendorTransitionGoal(asActive(state.goal, "active"), "blocked");
	const runtime = getGoalRuntime();
	if (runtime) {
		runtime.activeGoal = next;
		runtime.setTerminalReason(next.id, trimmed);
		runtime.persistGoal(next);
	}
	const goal = projectGoal(next, state.goal);
	goal.blockReason = trimmed;
	goal.continuationTicket = undefined;
	return ok({ ...state, goal }, goal);
}

export function peekGoalVendorReachable(): boolean {
	const sample = vendorCreateGoal("probe", undefined, 0);
	return typeof sample.id === "string" && sample.status === "active";
}
