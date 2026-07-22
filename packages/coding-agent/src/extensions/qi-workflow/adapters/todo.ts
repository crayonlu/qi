/**
 * Thin Qi adapter over adopted rpiv-todo reducer/store.
 * Vendor TaskState is the mutation source of truth; Qi TodoItem[] is the
 * dashboard/board projection (docs/07 placement).
 */

import { workflowController } from "../controller.ts";
import { nowMs } from "../domain/ids.ts";
import type { TransitionResult } from "../domain/result.ts";
import type { QiWorkflowState, TodoItem, TodoStatus } from "../domain/types.ts";
import { EMPTY_STATE, type TaskState } from "../vendor/todo/state/state.ts";
import { applyTaskMutation, type Op } from "../vendor/todo/state/state-reducer.ts";
import { commitState, getState, sid } from "../vendor/todo/state/store.ts";
import { formatContent } from "../vendor/todo/tool/response-envelope.ts";
import type { Task, TaskAction, TaskMutationParams } from "../vendor/todo/tool/types.ts";

function fail<T>(state: QiWorkflowState, error: string): TransitionResult<T> {
	return { ok: false, error, state };
}

function ok<T>(state: QiWorkflowState, value: T): TransitionResult<T> {
	return { ok: true, value, state };
}

function toQiTodoStatus(status: Task["status"]): TodoStatus {
	if (status === "in_progress") return "in_progress";
	if (status === "completed") return "completed";
	if (status === "deleted") return "cancelled";
	return "pending";
}

function projectTodos(tasks: Task[], previous: TodoItem[], goalId?: string): TodoItem[] {
	const prevByKey = new Map(previous.map((t) => [t.text, t]));
	const t = nowMs();
	return tasks
		.filter((task) => task.status !== "deleted")
		.map((task, index) => {
			const key = `todo_${task.id}`;
			const prev = previous.find((p) => p.id === key) ?? prevByKey.get(task.subject);
			return {
				id: key,
				text: task.subject,
				summary: task.subject,
				status: toQiTodoStatus(task.status),
				position: index,
				goalId: goalId ?? prev?.goalId,
				taskIds: prev?.taskIds ?? [],
				blockReason: prev?.blockReason,
				verification: prev?.verification,
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

export interface TodoMutationResult {
	op: Op;
	content: string;
	todos: TodoItem[];
}

/**
 * Apply a vendor todo mutation and project into Qi workflow state.
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
	const content = formatContent(result.op, result.state);
	return ok({ ...qiState, todos }, { op: result.op, content, todos });
}

export function addTodoViaVendor(qiState: QiWorkflowState, text: string): TransitionResult<TodoItem> {
	const mutated = mutateTodoViaVendor(qiState, "create", { subject: text });
	if (!mutated.ok) return fail(qiState, mutated.error);
	const created = mutated.value.todos[mutated.value.todos.length - 1];
	if (!created) return fail(qiState, "Failed to create todo");
	return ok(mutated.state, created);
}

export function listTodosViaVendor(): { content: string; count: number } {
	const { state } = vendorSlot();
	const result = applyTaskMutation(state, "list", {});
	return {
		content: formatContent(result.op, result.state),
		count: result.state.tasks.filter((t) => t.status !== "deleted").length,
	};
}

/** Resolve Qi todo id (`todo_N` or raw) to vendor numeric id. */
export function resolveVendorTodoId(id: string): number | undefined {
	const m = /^todo_(\d+)$/.exec(id);
	if (m) return Number(m[1]);
	const asNum = Number(id);
	if (Number.isFinite(asNum)) return asNum;
	return undefined;
}

export function peekTodoVendorReachable(): boolean {
	const result = applyTaskMutation({ ...EMPTY_STATE, tasks: [] }, "create", { subject: "probe" });
	return result.op.kind === "create";
}

export { sid };
