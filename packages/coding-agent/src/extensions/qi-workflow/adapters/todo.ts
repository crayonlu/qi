/**
 * Thin Qi adapter — vendor TaskState is the sole mutation source of truth.
 * Qi TodoItem[] is a projection for dashboard/UI.
 * Every commit appends qi-todo-state so resume/compact/tree replay cannot wipe work.
 */

import { workflowController } from "../controller.ts";
import { nowMs } from "../domain/ids.ts";
import type { TransitionResult } from "../domain/result.ts";
import type { Plan, QiWorkflowState, TodoItem, TodoStatus } from "../domain/types.ts";
import { QI_TODO_STATE_CUSTOM_TYPE, replayFromBranch } from "../vendor/todo/state/replay.ts";
import { EMPTY_STATE, type TaskState } from "../vendor/todo/state/state.ts";
import { applyTaskMutation, type Op } from "../vendor/todo/state/state-reducer.ts";
import { commitState, evictSession, getState, replaceState, sid } from "../vendor/todo/state/store.ts";
import { buildToolResult, formatContent } from "../vendor/todo/tool/response-envelope.ts";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "../vendor/todo/tool/types.ts";

const META_BLOCK_REASON = "qiBlockReason";
const META_QI_STATUS = "qiStatus";
const META_VERIFICATION = "verification";
const META_GOAL_ID = "goalId";

function fail<T>(state: QiWorkflowState, error: string): TransitionResult<T> {
	return { ok: false, error, state };
}

function ok<T>(state: QiWorkflowState, value: T): TransitionResult<T> {
	return { ok: true, value, state };
}

function metaString(task: Task, key: string): string | undefined {
	const v = task.metadata?.[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toQiTodoStatus(task: Task): TodoStatus {
	if (metaString(task, META_QI_STATUS) === "blocked" || metaString(task, META_BLOCK_REASON)) {
		return "blocked";
	}
	if (task.status === "in_progress") return "in_progress";
	if (task.status === "completed") return "completed";
	if (task.status === "deleted") return "cancelled";
	return "pending";
}

function projectTodos(tasks: Task[], previous: TodoItem[], goalId?: string): TodoItem[] {
	const prevByVendor = new Map(previous.filter((t) => t.vendorId !== undefined).map((t) => [t.vendorId!, t]));
	const t = nowMs();
	return tasks
		.filter((task) => task.status !== "deleted")
		.map((task, index) => {
			const key = `todo_${task.id}`;
			const prev = prevByVendor.get(task.id) ?? previous.find((p) => p.id === key);
			const blockReason = metaString(task, META_BLOCK_REASON);
			const verification = metaString(task, META_VERIFICATION);
			const linkedGoal = metaString(task, META_GOAL_ID) ?? goalId ?? prev?.goalId;
			return {
				id: key,
				text: task.subject,
				summary: blockReason ? `Blocked: ${blockReason}` : task.subject,
				status: toQiTodoStatus(task),
				position: index,
				goalId: linkedGoal,
				taskIds: prev?.taskIds ?? [],
				blockReason,
				verification,
				vendorId: task.id,
				activeForm: task.activeForm,
				blockedBy: task.blockedBy ? [...task.blockedBy] : undefined,
				description: task.description,
				owner: task.owner,
				createdAt: prev?.createdAt ?? t,
				updatedAt: t,
				revision: (prev?.revision ?? 0) + 1,
			} satisfies TodoItem;
		});
}

function sessionId(): string {
	try {
		return workflowController.getState().sessionId ?? "";
	} catch {
		return "";
	}
}

function vendorSlot(): { session: string; state: TaskState } {
	const session = sessionId();
	return { session, state: getState(session) };
}

function persistVendorSnapshot(details: TaskDetails): void {
	workflowController.appendCustom(QI_TODO_STATE_CUSTOM_TYPE, details);
}

export interface TodoMutationResult {
	op: Op;
	content: string;
	todos: TodoItem[];
	details: TaskDetails;
}

/**
 * Apply a vendor todo mutation, project into Qi state, and append branch snapshot.
 */
export function mutateTodoViaVendor(
	qiState: QiWorkflowState,
	action: TaskAction,
	params: TaskMutationParams,
): TransitionResult<TodoMutationResult> {
	const { session, state } = vendorSlot();
	const result = applyTaskMutation(state, action, params);
	if (result.op.kind === "error") {
		return fail(qiState, result.op.message);
	}
	commitState(session, result.state);
	const todos = projectTodos(result.state.tasks, qiState.todos, qiState.goal?.id);
	const envelope = buildToolResult(action, params, result.state, result.op);
	persistVendorSnapshot(envelope.details);

	let nextState: QiWorkflowState = { ...qiState, todos };
	if (qiState.goal && action === "create") {
		const created = todos[todos.length - 1];
		if (created) {
			const goal = {
				...qiState.goal,
				todoIds: [...new Set([...qiState.goal.todoIds, created.id])],
				revision: qiState.goal.revision + 1,
				updatedAt: nowMs(),
			};
			nextState = { ...nextState, goal };
		}
	}
	return ok(nextState, {
		op: result.op,
		content: envelope.content[0]?.text ?? formatContent(result.op, result.state),
		todos,
		details: envelope.details,
	});
}

export function addTodoViaVendor(
	qiState: QiWorkflowState,
	text: string,
	opts?: { description?: string; owner?: string; activeForm?: string; blockedBy?: number[] },
): TransitionResult<TodoItem> {
	const goalId = qiState.goal?.id;
	const mutated = mutateTodoViaVendor(qiState, "create", {
		subject: text,
		description: opts?.description,
		owner: opts?.owner,
		activeForm: opts?.activeForm,
		blockedBy: opts?.blockedBy,
		metadata: goalId ? { [META_GOAL_ID]: goalId } : undefined,
	});
	if (!mutated.ok) return fail(qiState, mutated.error);
	const created = mutated.value.todos[mutated.value.todos.length - 1];
	if (!created) return fail(qiState, "Failed to create todo");
	return ok(mutated.state, created);
}

export function startTodoViaVendor(qiState: QiWorkflowState, id: string): TransitionResult<TodoItem> {
	const vendorId = resolveVendorTodoId(id);
	if (vendorId === undefined) return fail(qiState, `Unknown todo id: ${id}`);
	const mutated = mutateTodoViaVendor(qiState, "update", {
		id: vendorId,
		status: "in_progress",
		metadata: { [META_QI_STATUS]: null, [META_BLOCK_REASON]: null },
	});
	if (!mutated.ok) return fail(qiState, mutated.error);
	const item = mutated.value.todos.find((t) => t.vendorId === vendorId);
	if (!item) return fail(qiState, `Todo not found after start: ${id}`);
	return ok(mutated.state, item);
}

/** Human block reason stored in vendor metadata so replay preserves it. */
export function blockTodoViaVendor(qiState: QiWorkflowState, id: string, reason: string): TransitionResult<TodoItem> {
	const vendorId = resolveVendorTodoId(id);
	if (vendorId === undefined) return fail(qiState, `Unknown todo id: ${id}`);
	const trimmed = reason.trim();
	if (!trimmed) return fail(qiState, "Block reason is required");
	const mutated = mutateTodoViaVendor(qiState, "update", {
		id: vendorId,
		metadata: { [META_QI_STATUS]: "blocked", [META_BLOCK_REASON]: trimmed },
	});
	if (!mutated.ok) return fail(qiState, mutated.error);
	const item = mutated.value.todos.find((t) => t.vendorId === vendorId);
	if (!item) return fail(qiState, `Todo not found after block: ${id}`);
	return ok(mutated.state, item);
}

export function completeTodoViaVendor(
	qiState: QiWorkflowState,
	id: string,
	verification?: string,
): TransitionResult<TodoItem> {
	const vendorId = resolveVendorTodoId(id);
	if (vendorId === undefined) return fail(qiState, `Unknown todo id: ${id}`);
	const mutated = mutateTodoViaVendor(qiState, "update", {
		id: vendorId,
		status: "completed",
		metadata: {
			[META_QI_STATUS]: null,
			[META_BLOCK_REASON]: null,
			...(verification?.trim() ? { [META_VERIFICATION]: verification.trim() } : {}),
		},
	});
	if (!mutated.ok) return fail(qiState, mutated.error);
	const item = mutated.value.todos.find((t) => t.vendorId === vendorId);
	if (!item) return fail(qiState, `Todo not found after complete: ${id}`);
	return ok(mutated.state, item);
}

export function cancelTodoViaVendor(qiState: QiWorkflowState, id: string): TransitionResult<TodoItem> {
	const vendorId = resolveVendorTodoId(id);
	if (vendorId === undefined) return fail(qiState, `Unknown todo id: ${id}`);
	const mutated = mutateTodoViaVendor(qiState, "delete", { id: vendorId });
	if (!mutated.ok) return fail(qiState, mutated.error);
	const cancelled: TodoItem = {
		id: `todo_${vendorId}`,
		text: id,
		summary: `Cancelled: ${id}`,
		status: "cancelled",
		position: 0,
		taskIds: [],
		vendorId,
		createdAt: nowMs(),
		updatedAt: nowMs(),
		revision: 1,
	};
	return ok(mutated.state, cancelled);
}

export function removeTodoViaVendor(qiState: QiWorkflowState, id: string): TransitionResult<null> {
	const vendorId = resolveVendorTodoId(id);
	if (vendorId === undefined) return fail(qiState, `Unknown todo id: ${id}`);
	const mutated = mutateTodoViaVendor(qiState, "delete", { id: vendorId });
	if (!mutated.ok) return fail(qiState, mutated.error);
	let next = mutated.state;
	if (next.goal) {
		const goal = {
			...next.goal,
			todoIds: next.goal.todoIds.filter((tid) => tid !== `todo_${vendorId}`),
			revision: next.goal.revision + 1,
			updatedAt: nowMs(),
		};
		next = { ...next, goal };
	}
	return ok(next, null);
}

export function executePlanToTodosViaVendor(
	qiState: QiWorkflowState,
	expectedRevision?: number,
): TransitionResult<{ plan: Plan; todos: TodoItem[] }> {
	if (!qiState.plan || qiState.plan.status !== "ready") return fail(qiState, "Plan must be ready to execute");
	if (expectedRevision !== undefined && qiState.plan.revision !== expectedRevision) {
		return fail(qiState, "Stale plan revision");
	}
	let next = qiState;
	const created: TodoItem[] = [];
	for (const step of qiState.plan.sections.steps) {
		const result = addTodoViaVendor(next, step);
		if (!result.ok) return fail(qiState, result.error);
		next = result.state;
		created.push(result.value);
	}
	const targetId = created.map((todo) => todo.id).join(",") || "todos";
	const plan: Plan = {
		...next.plan!,
		status: "executing",
		conversionTarget: { kind: "todos", targetId },
		summary: `Executing via todos: ${next.plan!.goal}`,
		revision: next.plan!.revision + 1,
		updatedAt: nowMs(),
	};
	next = { ...next, plan };
	return ok(next, { plan, todos: created });
}

export function listTodosViaVendor(opts?: { status?: Task["status"]; includeDeleted?: boolean }): {
	content: string;
	count: number;
	details: TaskDetails;
} {
	const { state } = vendorSlot();
	const result = applyTaskMutation(state, "list", {
		status: opts?.status,
		includeDeleted: opts?.includeDeleted,
	});
	const envelope = buildToolResult("list", opts ?? {}, result.state, result.op);
	return {
		content: envelope.content[0]?.text ?? formatContent(result.op, result.state),
		count: result.state.tasks.filter((t) => (opts?.includeDeleted ? true : t.status !== "deleted")).length,
		details: envelope.details,
	};
}

export function getTodoViaVendor(id: string): TransitionResult<{ content: string; details: TaskDetails }> {
	const vendorId = resolveVendorTodoId(id);
	if (vendorId === undefined) return fail(workflowController.getState(), `Unknown todo id: ${id}`);
	const qiState = workflowController.getState();
	const mutated = mutateTodoViaVendor(qiState, "get", { id: vendorId });
	if (!mutated.ok) return fail(qiState, mutated.error);
	return ok(mutated.state, { content: mutated.value.content, details: mutated.value.details });
}

export function clearTodosViaVendor(qiState: QiWorkflowState): TransitionResult<TodoMutationResult> {
	return mutateTodoViaVendor(qiState, "clear", {});
}

/** Resolve Qi todo id (`todo_N` or raw) to vendor numeric id. */
export function resolveVendorTodoId(id: string): number | undefined {
	const m = /^todo_(\d+)$/.exec(id);
	if (m) return Number(m[1]);
	const asNum = Number(id);
	if (Number.isFinite(asNum)) return asNum;
	return undefined;
}

/** Replay vendor store from branch and project into Qi domain. */
export function syncTodoStoreFromBranch(ctx: {
	sessionManager: { getSessionId(): string; getBranch(): Iterable<unknown> };
}): void {
	const session = sid(ctx);
	const replayed = replayFromBranch(ctx);
	replaceState(session, replayed);
	workflowController.apply((qiState) => {
		const todos = projectTodos(replayed.tasks, qiState.todos, qiState.goal?.id);
		return { ok: true as const, value: todos, state: { ...qiState, todos } };
	});
}

export function evictTodoSession(sessionId: string): void {
	evictSession(sessionId);
}

export function peekTodoVendorReachable(): boolean {
	const result = applyTaskMutation({ ...EMPTY_STATE, tasks: [] }, "create", { subject: "probe" });
	return result.op.kind === "create" && typeof replayFromBranch === "function";
}

export { sid, QI_TODO_STATE_CUSTOM_TYPE };
