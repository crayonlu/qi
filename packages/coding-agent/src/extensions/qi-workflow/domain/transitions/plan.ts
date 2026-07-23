import { newId, nowMs } from "../ids.ts";
import type { TransitionResult } from "../result.ts";
import type {
	ConversionTargetKind,
	Plan,
	PlanSections,
	PlanStatus,
	QiWorkflowState,
	WorkflowEntity,
} from "../types.ts";
import { emptySections } from "../types.ts";

function bump(entity: { revision: number; updatedAt: number }): void {
	entity.revision += 1;
	entity.updatedAt = nowMs();
}

function fail<T>(state: QiWorkflowState, error: string): TransitionResult<T> {
	return { ok: false, error, state };
}

function ok<T>(state: QiWorkflowState, value: T): TransitionResult<T> {
	return { ok: true, value, state };
}

export function startPlan(state: QiWorkflowState, goal: string): TransitionResult<Plan> {
	const trimmed = goal.trim();
	if (!trimmed) return fail(state, "Plan goal is required");
	const t = nowMs();
	const plan: Plan = {
		id: newId("plan"),
		goal: trimmed,
		summary: trimmed,
		status: "draft",
		sections: emptySections(),
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...state, plan }, plan);
}

/** Infer a plan goal from active goal / todos when tools auto-create. */
export function inferPlanGoal(state: QiWorkflowState, hint?: string): string {
	const fromHint = hint?.trim();
	if (fromHint) return fromHint;
	const fromGoal = state.goal?.objective?.trim();
	if (fromGoal) return fromGoal;
	const activeTodo =
		state.todos.find((t) => t.status === "in_progress") ?? state.todos.find((t) => t.status === "pending");
	const fromTodo = activeTodo?.text?.trim();
	if (fromTodo) return fromTodo;
	return "Untitled plan";
}

/** Return the active plan, or start one (harness: tools should not fail with "No active plan"). */
export function ensureActivePlan(state: QiWorkflowState, goalHint?: string): TransitionResult<Plan> {
	if (state.plan && state.plan.status !== "discarded") return ok(state, state.plan);
	return startPlan(state, inferPlanGoal(state, goalHint));
}

export function editPlanGoal(state: QiWorkflowState, goal: string, expectedRevision?: number): TransitionResult<Plan> {
	if (!state.plan || state.plan.status === "discarded") return fail(state, "No active plan");
	if (expectedRevision !== undefined && state.plan.revision !== expectedRevision) {
		return fail(state, "Stale plan revision");
	}
	const trimmed = goal.trim();
	if (!trimmed) return fail(state, "Plan goal is required");
	const plan = { ...state.plan, goal: trimmed, summary: trimmed };
	bump(plan);
	return ok({ ...state, plan }, plan);
}

export function updatePlanSections(
	state: QiWorkflowState,
	patch: Partial<PlanSections>,
	expectedRevision?: number,
	goalHint?: string,
): TransitionResult<Plan> {
	let working = state;
	if (!working.plan || working.plan.status === "discarded") {
		// Auto-create — plan_update must not force /plan first.
		const ensured = ensureActivePlan(working, goalHint);
		if (!ensured.ok) return ensured;
		working = ensured.state;
		// Fresh plan: skip revision check (caller may have sent stale/undefined rev).
		expectedRevision = undefined;
	}
	if (working.plan!.status !== "draft" && working.plan!.status !== "ready") {
		return fail(working, `Cannot update sections in status ${working.plan!.status}`);
	}
	if (expectedRevision !== undefined && working.plan!.revision !== expectedRevision) {
		return fail(working, "Stale plan revision");
	}
	const plan = {
		...working.plan!,
		sections: { ...working.plan!.sections, ...patch },
		status: "draft" as PlanStatus,
	};
	bump(plan);
	return ok({ ...working, plan }, plan);
}

/** Typed ready transition — never driven by assistant prose. */
export function markPlanReady(
	state: QiWorkflowState,
	expectedRevision?: number,
	goalHint?: string,
): TransitionResult<Plan> {
	let working = state;
	if (!working.plan || working.plan.status === "discarded") {
		const ensured = ensureActivePlan(working, goalHint);
		if (!ensured.ok) return ensured;
		working = ensured.state;
		expectedRevision = undefined;
	}
	if (working.plan!.status !== "draft" && working.plan!.status !== "ready") {
		return fail(working, `Cannot mark ready from status ${working.plan!.status}`);
	}
	if (expectedRevision !== undefined && working.plan!.revision !== expectedRevision) {
		return fail(working, "Stale plan revision");
	}
	if (working.plan!.sections.steps.length === 0) {
		return fail(working, "Plan needs at least one step before ready");
	}
	const plan = {
		...working.plan!,
		status: "ready" as PlanStatus,
		summary: `Ready: ${working.plan!.goal}`,
	};
	bump(plan);
	return ok({ ...working, plan }, plan);
}

export function discardPlan(state: QiWorkflowState, expectedRevision?: number): TransitionResult<Plan> {
	if (!state.plan) return fail(state, "No active plan");
	if (expectedRevision !== undefined && state.plan.revision !== expectedRevision) {
		return fail(state, "Stale plan revision");
	}
	const plan = { ...state.plan, status: "discarded" as PlanStatus, summary: `Discarded: ${state.plan.goal}` };
	bump(plan);
	return ok({ ...state, plan }, plan);
}

export function executePlanToWorkflow(
	state: QiWorkflowState,
	workflow: WorkflowEntity,
	expectedRevision?: number,
): TransitionResult<{ plan: Plan; workflow: WorkflowEntity }> {
	if (!state.plan || state.plan.status !== "ready") return fail(state, "Plan must be ready to execute");
	if (expectedRevision !== undefined && state.plan.revision !== expectedRevision) {
		return fail(state, "Stale plan revision");
	}
	const plan = {
		...state.plan,
		status: "executing" as PlanStatus,
		conversionTarget: { kind: "workflow" as ConversionTargetKind, targetId: workflow.id },
		summary: `Executing via workflow: ${state.plan.goal}`,
	};
	bump(plan);
	const workflows = [...state.workflows.filter((item) => item.id !== workflow.id), workflow];
	return ok({ ...state, plan, workflows }, { plan, workflow });
}

/** Assistant prose must never call this — tests assert prose paths don't reach ready/execute. */
export function planFromAssistantProse(_state: QiWorkflowState, _text: string): TransitionResult<null> {
	return fail(_state, "Ordinary assistant prose cannot change plan status");
}
