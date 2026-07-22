import { newId, nowMs } from "../ids.ts";
import type { TransitionResult } from "../result.ts";
import type {
	ConversionTargetKind,
	Plan,
	PlanSections,
	PlanStatus,
	QiWorkflowState,
	TodoItem,
	WorkflowEntity,
} from "../types.ts";
import { emptySections } from "../types.ts";
import { addTodo } from "./goal-todo.ts";

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
): TransitionResult<Plan> {
	if (!state.plan || state.plan.status === "discarded") return fail(state, "No active plan");
	if (state.plan.status !== "draft" && state.plan.status !== "ready") {
		return fail(state, `Cannot update sections in status ${state.plan.status}`);
	}
	if (expectedRevision !== undefined && state.plan.revision !== expectedRevision) {
		return fail(state, "Stale plan revision");
	}
	const plan = {
		...state.plan,
		sections: { ...state.plan.sections, ...patch },
		status: "draft" as PlanStatus,
	};
	bump(plan);
	return ok({ ...state, plan }, plan);
}

/** Typed ready transition — never driven by assistant prose. */
export function markPlanReady(state: QiWorkflowState, expectedRevision?: number): TransitionResult<Plan> {
	if (!state.plan || state.plan.status === "discarded") return fail(state, "No active plan");
	if (state.plan.status !== "draft" && state.plan.status !== "ready") {
		return fail(state, `Cannot mark ready from status ${state.plan.status}`);
	}
	if (expectedRevision !== undefined && state.plan.revision !== expectedRevision) {
		return fail(state, "Stale plan revision");
	}
	if (state.plan.sections.steps.length === 0) {
		return fail(state, "Plan needs at least one step before ready");
	}
	const plan = { ...state.plan, status: "ready" as PlanStatus, summary: `Ready: ${state.plan.goal}` };
	bump(plan);
	return ok({ ...state, plan }, plan);
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

export function executePlanToTodos(
	state: QiWorkflowState,
	expectedRevision?: number,
): TransitionResult<{ plan: Plan; todos: TodoItem[] }> {
	if (!state.plan || state.plan.status !== "ready") return fail(state, "Plan must be ready to execute");
	if (expectedRevision !== undefined && state.plan.revision !== expectedRevision) {
		return fail(state, "Stale plan revision");
	}

	let next = state;
	const created: TodoItem[] = [];
	for (const step of state.plan.sections.steps) {
		const result = addTodo(next, step);
		if (!result.ok) return fail(state, result.error);
		next = result.state;
		created.push(result.value);
	}

	const targetId = created.map((todo) => todo.id).join(",") || newId("todos");
	const plan = {
		...next.plan!,
		status: "executing" as PlanStatus,
		conversionTarget: { kind: "todos" as ConversionTargetKind, targetId },
		summary: `Executing via todos: ${next.plan!.goal}`,
	};
	bump(plan);
	next = { ...next, plan };
	return ok(next, { plan, todos: created });
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
