import { newId, nowMs } from "../ids.ts";
import type { TransitionResult } from "../result.ts";
import type {
	QiWorkflowState,
	TaskEntity,
	TaskStatus,
	WorkflowEntity,
	WorkflowMode,
	WorkflowStatus,
} from "../types.ts";
import { WORKFLOW_MAX_PARALLEL } from "../types.ts";

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

export function createTask(
	state: QiWorkflowState,
	goal: string,
	opts?: { workflowId?: string; parentSessionId?: string },
): TransitionResult<TaskEntity> {
	const trimmed = goal.trim();
	if (!trimmed) return fail(state, "Task goal is required");
	const t = nowMs();
	const task: TaskEntity = {
		id: newId("task"),
		goal: trimmed,
		summary: trimmed,
		status: "pending",
		workflowId: opts?.workflowId,
		parentSessionId: opts?.parentSessionId,
		attached: false,
		cancelRequested: false,
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...state, tasks: [...state.tasks, task] }, task);
}

export function setTaskRunning(
	state: QiWorkflowState,
	id: string,
	childSessionId?: string,
): TransitionResult<TaskEntity> {
	const task = state.tasks.find((item) => item.id === id);
	if (!task) return fail(state, `Task not found: ${id}`);
	if (task.cancelRequested) {
		const cancelled = { ...task, status: "cancelled" as TaskStatus, summary: `Cancelled: ${task.goal}` };
		bump(cancelled);
		return ok({ ...state, tasks: state.tasks.map((item) => (item.id === id ? cancelled : item)) }, cancelled);
	}
	const updated = {
		...task,
		status: "running" as TaskStatus,
		childSessionId: childSessionId ?? task.childSessionId,
		summary: `Running: ${task.goal}`,
	};
	bump(updated);
	return ok({ ...state, tasks: state.tasks.map((item) => (item.id === id ? updated : item)) }, updated);
}

export function completeTask(state: QiWorkflowState, id: string, resultSummary: string): TransitionResult<TaskEntity> {
	const task = state.tasks.find((item) => item.id === id);
	if (!task) return fail(state, `Task not found: ${id}`);
	if (task.status === "cancelled") return ok(state, task);
	const updated = {
		...task,
		status: "completed" as TaskStatus,
		resultSummary,
		summary: `Completed: ${task.goal}`,
	};
	bump(updated);
	return ok({ ...state, tasks: state.tasks.map((item) => (item.id === id ? updated : item)) }, updated);
}

export function failTask(state: QiWorkflowState, id: string, error: string): TransitionResult<TaskEntity> {
	const task = state.tasks.find((item) => item.id === id);
	if (!task) return fail(state, `Task not found: ${id}`);
	if (task.status === "cancelled") return ok(state, task);
	const updated = {
		...task,
		status: "failed" as TaskStatus,
		error,
		summary: `Failed: ${error}`,
	};
	bump(updated);
	return ok({ ...state, tasks: state.tasks.map((item) => (item.id === id ? updated : item)) }, updated);
}

export function cancelTask(state: QiWorkflowState, id: string): TransitionResult<TaskEntity> {
	const task = state.tasks.find((item) => item.id === id || item.id.endsWith(id));
	if (!task) return fail(state, `Task not found: ${id}`);
	const updated = {
		...task,
		cancelRequested: true,
		status: task.status === "pending" || task.status === "running" ? ("cancelled" as TaskStatus) : task.status,
		summary: `Cancelled: ${task.goal}`,
	};
	bump(updated);
	return ok({ ...state, tasks: state.tasks.map((item) => (item.id === task.id ? updated : item)) }, updated);
}

export function attachTask(state: QiWorkflowState, id: string): TransitionResult<TaskEntity> {
	const task = state.tasks.find((item) => item.id === id || item.id.endsWith(id));
	if (!task) return fail(state, `Task not found: ${id}`);
	const updated = { ...task, attached: true };
	bump(updated);
	return ok({ ...state, tasks: state.tasks.map((item) => (item.id === task.id ? updated : item)) }, updated);
}

/** After restart: terminal work must not remain "running". */
export function recoverTaskStatuses(state: QiWorkflowState): TransitionResult<null> {
	const tasks = state.tasks.map((task) => {
		if (task.status !== "running" && task.status !== "pending") return task;
		if (task.cancelRequested) {
			const updated = { ...task, status: "cancelled" as TaskStatus, summary: `Cancelled: ${task.goal}` };
			bump(updated);
			return updated;
		}
		// Running without live child after restart → unknown (not running).
		if (task.status === "running") {
			const updated = { ...task, status: "unknown" as TaskStatus, summary: `Interrupted: ${task.goal}` };
			bump(updated);
			return updated;
		}
		return task;
	});
	return ok({ ...state, tasks }, null);
}

export function createWorkflow(
	state: QiWorkflowState,
	goal: string,
	mode: WorkflowMode,
	background: boolean,
	taskGoals: string[],
): TransitionResult<WorkflowEntity> {
	const trimmed = goal.trim();
	if (!trimmed) return fail(state, "Workflow goal is required");
	if (mode === "parallel" && taskGoals.length > WORKFLOW_MAX_PARALLEL) {
		return fail(state, `Parallel workflows support at most ${WORKFLOW_MAX_PARALLEL} tasks`);
	}

	const t = nowMs();
	const workflowId = newId("wf");
	let next = state;
	const taskIds: string[] = [];
	const goals = taskGoals.length > 0 ? taskGoals : [trimmed];
	for (const taskGoal of goals) {
		const created = createTask(next, taskGoal, { workflowId });
		if (!created.ok) return fail(state, created.error);
		next = created.state;
		taskIds.push(created.value.id);
	}

	const workflow: WorkflowEntity = {
		id: workflowId,
		goal: trimmed,
		summary: trimmed,
		status: "pending",
		mode,
		taskIds,
		background,
		effectsApplied: false,
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...next, workflows: [...next.workflows, workflow] }, workflow);
}

export function setWorkflowStatus(
	state: QiWorkflowState,
	id: string,
	status: WorkflowStatus,
	extra?: Partial<Pick<WorkflowEntity, "resultSummary" | "error" | "effectsApplied">>,
): TransitionResult<WorkflowEntity> {
	const workflow = state.workflows.find((item) => item.id === id);
	if (!workflow) return fail(state, `Workflow not found: ${id}`);
	const updated = {
		...workflow,
		status,
		...extra,
		summary:
			status === "completed"
				? `Completed: ${workflow.goal}`
				: status === "failed"
					? `Failed: ${extra?.error ?? workflow.goal}`
					: status === "cancelled"
						? `Cancelled: ${workflow.goal}`
						: workflow.summary,
	};
	bump(updated);
	return ok({ ...state, workflows: state.workflows.map((item) => (item.id === id ? updated : item)) }, updated);
}

export function cancelWorkflow(state: QiWorkflowState, id: string): TransitionResult<WorkflowEntity> {
	const workflow = state.workflows.find((item) => item.id === id || item.id.endsWith(id));
	if (!workflow) return fail(state, `Workflow not found: ${id}`);
	let next = state;
	for (const taskId of workflow.taskIds) {
		const cancelled = cancelTask(next, taskId);
		if (cancelled.ok) next = cancelled.state;
	}
	return setWorkflowStatus(next, workflow.id, "cancelled");
}

export function recoverWorkflowStatuses(state: QiWorkflowState): TransitionResult<null> {
	const recoveredTasks = recoverTaskStatuses(state);
	let next = recoveredTasks.state;
	const workflows = next.workflows.map((workflow) => {
		if (workflow.status !== "running" && workflow.status !== "pending") return workflow;
		if (workflow.effectsApplied) {
			const updated = { ...workflow, status: "unknown" as WorkflowStatus, summary: `Interrupted: ${workflow.goal}` };
			bump(updated);
			return updated;
		}
		const updated = { ...workflow, status: "unknown" as WorkflowStatus, summary: `Interrupted: ${workflow.goal}` };
		bump(updated);
		return updated;
	});
	next = { ...next, workflows };
	return ok(next, null);
}

export function markWorkflowEffectsApplied(state: QiWorkflowState, id: string): TransitionResult<WorkflowEntity> {
	return setWorkflowStatus(state, id, state.workflows.find((item) => item.id === id)?.status ?? "completed", {
		effectsApplied: true,
	});
}
