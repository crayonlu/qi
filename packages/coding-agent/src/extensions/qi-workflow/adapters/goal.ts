/**
 * Thin Qi adapter over adopted pi-goal runtime helpers.
 * Qi dashboard stores a projected Goal entity; create/transition rules come from vendor/goal.
 */

import { nowMs } from "../domain/ids.ts";
import type { TransitionResult } from "../domain/result.ts";
import type { Goal, GoalStatus, QiWorkflowState } from "../domain/types.ts";
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
	return "active";
}

function asActive(goal: Goal, status: ActiveGoal["status"]): ActiveGoal {
	return {
		id: goal.id,
		text: goal.objective,
		status,
		startedAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		iteration: goal.iteration,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
		activeStartedAt: status === "active" ? goal.updatedAt : undefined,
	};
}

function projectGoal(active: ActiveGoal, previous?: Goal | null): Goal {
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
		blockReason: previous?.blockReason,
		completionEvidence: previous?.completionEvidence,
		continuationTicket: previous?.continuationTicket,
	};
}

export function setGoalViaVendor(state: QiWorkflowState, objective: string): TransitionResult<Goal> {
	const trimmed = objective.trim();
	if (!trimmed) return fail(state, "Goal objective is required");
	const active = vendorCreateGoal(trimmed, undefined, 0);
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
	const goal = projectGoal(next, state.goal);
	goal.continuationTicket = undefined;
	return ok({ ...state, goal }, goal);
}

export function resumeGoalViaVendor(state: QiWorkflowState): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	if (state.goal.status !== "paused" && state.goal.status !== "blocked") {
		return fail(state, `Cannot resume goal in status ${state.goal.status}`);
	}
	const vendorStatus = state.goal.status === "blocked" ? "blocked" : "paused";
	const next = vendorTransitionGoal(asActive(state.goal, vendorStatus), "active");
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
	const rejection = goalIdRejectionReason(asActive(state.goal, "active"), goalId);
	if (rejection) return fail(state, rejection);
	if (isContradictoryCompletionSummary(evidence)) {
		return fail(state, "Completion evidence contradicts a finished objective");
	}
	const next = vendorTransitionGoal(asActive(state.goal, "active"), "complete");
	const goal = projectGoal(next, state.goal);
	goal.completionEvidence = evidence.trim();
	goal.continuationTicket = undefined;
	return ok({ ...state, goal }, goal);
}

export function blockGoalViaVendor(state: QiWorkflowState, reason: string, goalId: string): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	const rejection = goalIdRejectionReason(asActive(state.goal, "active"), goalId);
	if (rejection) return fail(state, rejection);
	const trimmed = reason.trim();
	if (!trimmed) return fail(state, "Block reason is required");
	const next = vendorTransitionGoal(asActive(state.goal, "active"), "blocked");
	const goal = projectGoal(next, state.goal);
	goal.blockReason = trimmed;
	goal.continuationTicket = undefined;
	return ok({ ...state, goal }, goal);
}

export function peekGoalVendorReachable(): boolean {
	const sample = vendorCreateGoal("probe", undefined, 0);
	return typeof sample.id === "string" && sample.status === "active";
}
