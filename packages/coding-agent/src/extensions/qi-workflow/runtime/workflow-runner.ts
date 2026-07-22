import type { Model } from "@earendil-works/pi-ai/compat";
import { workflowController } from "../controller.ts";
import {
	cancelTask,
	cancelWorkflow,
	createWorkflow,
	markWorkflowEffectsApplied,
	setWorkflowStatus,
	type TaskEntity,
	WORKFLOW_CONCURRENCY,
	WORKFLOW_MAX_PARALLEL,
	type WorkflowEntity,
	type WorkflowMode,
} from "../domain/index.ts";
import { runTask } from "./task-runner.ts";

const SUMMARY_MAX = 8 * 1024;

export interface RunWorkflowOptions {
	goal: string;
	mode: WorkflowMode;
	taskGoals?: string[];
	background?: boolean;
	cwd?: string;
	model?: Model<any>;
	signal?: AbortSignal;
}

export interface RunWorkflowResult {
	workflow: WorkflowEntity;
	/** Present when background=false, or after awaiting the tracked promise. */
	resultSummary?: string;
	promise?: Promise<string>;
}

const backgroundPromises = new Map<string, Promise<string>>();

function bound(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= SUMMARY_MAX) return trimmed;
	return `${trimmed.slice(0, SUMMARY_MAX)}\n…[truncated]`;
}

function getWorkflow(id: string): WorkflowEntity | undefined {
	return workflowController.getState().workflows.find((item) => item.id === id || item.id.endsWith(id));
}

function getTask(id: string): TaskEntity | undefined {
	return workflowController.getState().tasks.find((item) => item.id === id);
}

function isCancelRequested(workflowId: string, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	const workflow = getWorkflow(workflowId);
	return workflow?.status === "cancelled";
}

async function runPool(items: string[], concurrency: number, worker: (item: string) => Promise<void>): Promise<void> {
	const queue = items.slice();
	const runners: Promise<void>[] = [];
	const n = Math.max(1, concurrency);
	for (let i = 0; i < n; i++) {
		runners.push(
			(async () => {
				for (;;) {
					const item = queue.shift();
					if (item === undefined) return;
					await worker(item);
				}
			})(),
		);
	}
	await Promise.all(runners);
}

async function executeWorkflow(workflowId: string, options: RunWorkflowOptions): Promise<string> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

	// Recovery invariant: effectsApplied means side effects must not re-run.
	if (workflow.effectsApplied) {
		return bound(workflow.resultSummary ?? "Effects already applied; skipping re-run");
	}

	workflowController.apply((state) => setWorkflowStatus(state, workflowId, "running"));

	const taskIds = workflow.taskIds.slice();
	const summaries: string[] = [];

	try {
		if (isCancelRequested(workflowId, options.signal)) {
			workflowController.apply((state) => cancelWorkflow(state, workflowId));
			workflowController.apply((state) => markWorkflowEffectsApplied(state, workflowId));
			return bound("Cancelled");
		}

		if (workflow.mode === "single" || taskIds.length <= 1) {
			const taskId = taskIds[0];
			if (!taskId) throw new Error("Workflow has no tasks");
			summaries.push(
				await runTask(taskId, {
					cwd: options.cwd,
					model: options.model,
					signal: options.signal,
				}),
			);
		} else if (workflow.mode === "chain") {
			for (const taskId of taskIds) {
				if (isCancelRequested(workflowId, options.signal)) {
					workflowController.apply((state) => cancelWorkflow(state, workflowId));
					break;
				}
				summaries.push(
					await runTask(taskId, {
						cwd: options.cwd,
						model: options.model,
						signal: options.signal,
					}),
				);
			}
		} else {
			const limit = Math.min(WORKFLOW_MAX_PARALLEL, taskIds.length);
			const concurrency = Math.min(WORKFLOW_CONCURRENCY, limit);
			await runPool(taskIds.slice(0, limit), concurrency, async (taskId) => {
				if (isCancelRequested(workflowId, options.signal)) {
					workflowController.apply((state) => cancelTask(state, taskId));
					return;
				}
				const summary = await runTask(taskId, {
					cwd: options.cwd,
					model: options.model,
					signal: options.signal,
				});
				summaries.push(`${taskId}: ${summary}`);
			});
		}

		const latest = getWorkflow(workflowId);
		if (latest?.status === "cancelled" || options.signal?.aborted) {
			const resultSummary = bound(`Cancelled. Partial: ${summaries.join(" | ") || "(none)"}`);
			workflowController.apply((state) => setWorkflowStatus(state, workflowId, "cancelled", { resultSummary }));
			workflowController.apply((state) => markWorkflowEffectsApplied(state, workflowId));
			return resultSummary;
		}

		const failed = taskIds
			.map((id) => getTask(id))
			.filter((task): task is TaskEntity => !!task && task.status === "failed");
		if (failed.length > 0) {
			const error = failed.map((task) => task.error ?? task.id).join("; ");
			const resultSummary = bound(`Failed: ${error}`);
			workflowController.apply((state) => setWorkflowStatus(state, workflowId, "failed", { resultSummary, error }));
			workflowController.apply((state) => markWorkflowEffectsApplied(state, workflowId));
			return resultSummary;
		}

		const resultSummary = bound(summaries.join("\n---\n") || "Completed");
		workflowController.apply((state) => setWorkflowStatus(state, workflowId, "completed", { resultSummary }));
		workflowController.apply((state) => markWorkflowEffectsApplied(state, workflowId));
		return resultSummary;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		const resultSummary = bound(`Failed: ${error}`);
		workflowController.apply((state) => setWorkflowStatus(state, workflowId, "failed", { resultSummary, error }));
		workflowController.apply((state) => markWorkflowEffectsApplied(state, workflowId));
		throw err;
	}
}

export function getWorkflowPromise(workflowId: string): Promise<string> | undefined {
	return backgroundPromises.get(workflowId);
}

/**
 * Run an already-created workflow entity (e.g. after executePlanToWorkflow).
 * Does not call createWorkflow again.
 */
export async function runExistingWorkflow(
	workflowId: string,
	options: Omit<RunWorkflowOptions, "goal" | "mode" | "taskGoals"> = {},
): Promise<RunWorkflowResult> {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

	const promise = executeWorkflow(workflow.id, {
		goal: workflow.goal,
		mode: workflow.mode,
		background: options.background ?? workflow.background,
		cwd: options.cwd,
		model: options.model,
		signal: options.signal,
	}).finally(() => {
		backgroundPromises.delete(workflow.id);
	});
	backgroundPromises.set(workflow.id, promise);

	if (options.background) {
		return { workflow, promise };
	}

	const resultSummary = await promise;
	return { workflow: getWorkflow(workflow.id) ?? workflow, resultSummary, promise };
}

/**
 * Create and run a workflow. When background=true, returns immediately and tracks the promise.
 * Cancellation is durable via cancelWorkflow (sets cancelRequested on tasks).
 */
export async function runWorkflow(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
	const taskGoals = options.taskGoals ?? [];
	if (options.mode === "parallel" && taskGoals.length > WORKFLOW_MAX_PARALLEL) {
		throw new Error(`Parallel workflows support at most ${WORKFLOW_MAX_PARALLEL} tasks`);
	}

	const created = workflowController.apply((state) =>
		createWorkflow(state, options.goal, options.mode, options.background === true, taskGoals),
	);
	if (!created.ok) throw new Error(created.error);

	return runExistingWorkflow(created.value.id, options);
}

export function requestCancelWorkflow(id: string): WorkflowEntity {
	const result = workflowController.apply((state) => cancelWorkflow(state, id));
	if (!result.ok) throw new Error(result.error);
	return result.value;
}
