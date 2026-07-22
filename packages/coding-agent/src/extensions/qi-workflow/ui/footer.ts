/**
 * Single Qi footer status key — goal/plan/todos/tasks/jobs/mcp/fail signals.
 */

import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { JobEntity, McpServerState, QiWorkflowState, TaskEntity } from "../domain/index.ts";

export const QI_FOOTER_STATUS_KEY = "qi";

function isActiveTask(task: TaskEntity): boolean {
	return task.status === "pending" || task.status === "running";
}

function isActiveJob(job: JobEntity): boolean {
	return job.status === "running" || job.status === "terminating";
}

function isFailedTask(task: TaskEntity): boolean {
	return task.status === "failed";
}

function isFailedJob(job: JobEntity): boolean {
	return job.status === "failed" || job.status === "killed";
}

function isConnectedMcp(server: McpServerState): boolean {
	return server.enabled && server.status === "connected";
}

function isConnectingMcp(server: McpServerState): boolean {
	return server.enabled && server.status === "connecting";
}

function isErrorMcp(server: McpServerState): boolean {
	return server.enabled && (server.status === "error" || !!server.error);
}

/** Build footer text from nonzero workflow signals. */
export function buildFooterText(state: QiWorkflowState): string | undefined {
	const parts: string[] = [];

	const goal = state.goal;
	if (goal && (goal.status === "active" || goal.status === "paused" || goal.status === "blocked")) {
		let g = `goal:${goal.status}`;
		if (goal.tokenBudget && goal.tokenBudget > 0) g += `(${goal.tokensUsed}/${goal.tokenBudget})`;
		else if (goal.tokensUsed > 0) g += `(${goal.tokensUsed})`;
		parts.push(g);
	}

	const plan = state.plan;
	if (plan && (plan.status === "draft" || plan.status === "ready" || plan.status === "executing")) {
		parts.push(`plan:${plan.status}`);
	}

	const todos = state.todos.filter(
		(t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked",
	).length;
	if (todos > 0) parts.push(`todos=${todos}`);

	const tasks = state.tasks.filter(isActiveTask).length;
	const jobs = state.jobs.filter(isActiveJob).length;
	const fail =
		state.tasks.filter(isFailedTask).length +
		state.jobs.filter(isFailedJob).length +
		state.workflows.filter((w) => w.status === "failed").length;
	const mcpOk = state.mcpServers.filter(isConnectedMcp).length;
	const mcpConn = state.mcpServers.filter(isConnectingMcp).length;
	const mcpErr = state.mcpServers.filter(isErrorMcp).length;
	const checkpoints = state.rewindCheckpoints.length;

	if (tasks > 0) parts.push(`tasks=${tasks}`);
	if (jobs > 0) parts.push(`jobs=${jobs}`);
	if (fail > 0) parts.push(`fail=${fail}`);
	if (mcpOk > 0 || mcpConn > 0 || mcpErr > 0) {
		let mcp = `mcp=${mcpOk}`;
		if (mcpConn > 0) mcp += `~${mcpConn}`;
		if (mcpErr > 0) mcp += `!${mcpErr}`;
		parts.push(mcp);
	}
	if (checkpoints > 0) parts.push(`rw=${checkpoints}`);

	if (parts.length === 0) return undefined;
	return parts.join(" ");
}

/** Exactly one status key `"qi"`. Clears when nothing to show. */
export function refreshFooter(ctx: { ui: Pick<ExtensionUIContext, "setStatus"> }, state: QiWorkflowState): void {
	ctx.ui.setStatus(QI_FOOTER_STATUS_KEY, buildFooterText(state));
}
