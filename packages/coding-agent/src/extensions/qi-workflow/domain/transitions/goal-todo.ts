import { isContradictoryCompletionSummary } from "../../vendor/goal/contradiction.ts";
import { newId, nowMs } from "../ids.ts";
import type { TransitionResult } from "../result.ts";
import type { Goal, GoalStatus, QiWorkflowState, TodoItem } from "../types.ts";

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

function reindexTodos(todos: TodoItem[]): TodoItem[] {
	// Preserve caller order; only rewrite position fields.
	return todos.map((todo, index) => ({ ...todo, position: index }));
}

export function setGoal(state: QiWorkflowState, objective: string): TransitionResult<Goal> {
	const trimmed = objective.trim();
	if (!trimmed) return fail(state, "Goal objective is required");

	const t = nowMs();
	const goal: Goal = {
		id: newId("goal"),
		objective: trimmed,
		summary: trimmed,
		status: "active",
		todoIds: [],
		createdAt: t,
		updatedAt: t,
		revision: 1,
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};

	const next: QiWorkflowState = {
		...state,
		goal,
		todos: state.todos.filter((todo) => todo.goalId !== state.goal?.id),
	};
	return ok(next, goal);
}

export function editGoal(state: QiWorkflowState, objective: string): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	const trimmed = objective.trim();
	if (!trimmed) return fail(state, "Goal objective is required");
	const goal = { ...state.goal, objective: trimmed, summary: trimmed };
	bump(goal);
	return ok({ ...state, goal }, goal);
}

export function pauseGoal(state: QiWorkflowState): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	if (state.goal.status !== "active") return fail(state, `Cannot pause goal in status ${state.goal.status}`);
	const goal = { ...state.goal, status: "paused" as GoalStatus, continuationTicket: undefined };
	bump(goal);
	return ok({ ...state, goal }, goal);
}

export function resumeGoal(state: QiWorkflowState): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	if (state.goal.status !== "paused" && state.goal.status !== "blocked") {
		return fail(state, `Cannot resume goal in status ${state.goal.status}`);
	}
	const goal = { ...state.goal, status: "active" as GoalStatus, blockReason: undefined };
	bump(goal);
	return ok({ ...state, goal }, goal);
}

export function clearGoal(state: QiWorkflowState): TransitionResult<null> {
	if (!state.goal) return ok({ ...state, goal: null }, null);
	const goalId = state.goal.id;
	return ok(
		{
			...state,
			goal: null,
			todos: state.todos.filter((todo) => todo.goalId !== goalId),
		},
		null,
	);
}

export function completeGoal(state: QiWorkflowState, evidence: string, expectedId?: string): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	// When provided (model tools), goal_id must match; slash/UI may omit it.
	if (expectedId !== undefined && state.goal.id !== expectedId) {
		return fail(state, "goal_id does not match the current goal");
	}
	if (state.goal.status === "completed" || state.goal.status === "cancelled") {
		return fail(state, `Goal already ${state.goal.status}`);
	}
	const trimmed = evidence.trim();
	if (!trimmed) return fail(state, "Completion evidence is required");
	if (isContradictoryCompletionSummary(trimmed)) {
		return fail(state, "Completion summary is contradictory (says not complete / tests failing)");
	}
	const goal = {
		...state.goal,
		status: "completed" as GoalStatus,
		completionEvidence: trimmed,
		continuationTicket: undefined,
		summary: `Completed: ${state.goal.objective}`,
	};
	bump(goal);
	return ok({ ...state, goal }, goal);
}

export function blockGoal(state: QiWorkflowState, reason: string, expectedId?: string): TransitionResult<Goal> {
	if (!state.goal) return fail(state, "No active goal");
	if (expectedId !== undefined && state.goal.id !== expectedId) {
		return fail(state, "goal_id does not match the current goal");
	}
	const trimmed = reason.trim();
	if (!trimmed) return fail(state, "Block reason is required");
	const goal = {
		...state.goal,
		status: "blocked" as GoalStatus,
		blockReason: trimmed,
		continuationTicket: undefined,
		summary: `Blocked: ${trimmed}`,
	};
	bump(goal);
	return ok({ ...state, goal }, goal);
}

/**
 * Reserve a continuation ticket. Returns null ticket when duplicate or not eligible.
 * Bound to goalId+iteration so stale agent_end handlers cannot double-dispatch.
 */
export function claimContinuation(state: QiWorkflowState): TransitionResult<{ ticket: string; prompt: string } | null> {
	if (!state.goal || state.goal.status !== "active") return ok(state, null);
	if (state.goal.continuationTicket) return ok(state, null);

	const ticket = newId("cont");
	const goal = { ...state.goal, continuationTicket: ticket, iteration: state.goal.iteration + 1 };
	bump(goal);
	const prompt = [
		`[qi-goal-continuation ticket=${ticket} goal=${goal.id} iteration=${goal.iteration}]`,
		`Continue working toward the active goal: ${goal.objective}`,
		"Use goal_complete or goal_blocked tools with evidence when finished or stuck.",
		"Do not claim completion in ordinary prose.",
	].join("\n");
	return ok({ ...state, goal }, { ticket, prompt });
}

export function clearContinuationTicket(state: QiWorkflowState, ticket: string): TransitionResult<Goal | null> {
	if (!state.goal) return ok(state, null);
	if (state.goal.continuationTicket !== ticket) return ok(state, state.goal);
	const goal = { ...state.goal, continuationTicket: undefined };
	bump(goal);
	return ok({ ...state, goal }, goal);
}

/** Dashboard-only reorder of Qi projection positions. Vendor store has no position field. */
export function moveTodo(state: QiWorkflowState, id: string, position: number): TransitionResult<TodoItem> {
	const todos = state.todos.slice().sort((a, b) => a.position - b.position);
	const index = todos.findIndex((item) => item.id === id || item.id.endsWith(id));
	if (index < 0) return fail(state, `Todo not found: ${id}`);
	const [item] = todos.splice(index, 1);
	const target = Math.max(0, Math.min(position, todos.length));
	todos.splice(target, 0, item);
	const reindexed = reindexTodos(todos.map((todo) => ({ ...todo })));
	for (const todo of reindexed) bump(todo);
	const moved = reindexed.find((todo) => todo.id === item.id)!;
	return ok({ ...state, todos: reindexed }, moved);
}

export function linkTodoTask(state: QiWorkflowState, todoId: string, taskId: string): TransitionResult<TodoItem> {
	const todo = state.todos.find((item) => item.id === todoId);
	if (!todo) return fail(state, `Todo not found: ${todoId}`);
	if (todo.taskIds.includes(taskId)) return ok(state, todo);
	const updated = { ...todo, taskIds: [...todo.taskIds, taskId] };
	bump(updated);
	return ok({ ...state, todos: state.todos.map((item) => (item.id === todo.id ? updated : item)) }, updated);
}
