/**
 * Single Qi footer status key — goal/plan/todos/tasks/jobs/mcp/fail signals.
 * Compact, prioritized; low-value signals drop first when space is tight.
 */

import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { JobEntity, McpServerState, QiWorkflowState, TaskEntity } from "../domain/index.ts";
import { termCols } from "./layout.ts";

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

type FooterPart = { key: string; text: string; priority: number };

/** Build footer text from nonzero workflow signals. */
export function buildFooterText(state: QiWorkflowState, maxCols: number = termCols()): string | undefined {
	const parts: FooterPart[] = [];

	const goal = state.goal;
	if (goal && (goal.status === "active" || goal.status === "paused" || goal.status === "blocked")) {
		let g = `goal:${goal.status}`;
		if (goal.tokenBudget && goal.tokenBudget > 0) g += `(${goal.tokensUsed}/${goal.tokenBudget})`;
		else if (goal.tokensUsed > 0) g += `(${goal.tokensUsed})`;
		parts.push({ key: "goal", text: g, priority: 10 });
	}

	const plan = state.plan;
	if (plan && (plan.status === "draft" || plan.status === "ready" || plan.status === "executing")) {
		parts.push({ key: "plan", text: `plan:${plan.status}`, priority: 20 });
	}

	const todos = state.todos.filter(
		(t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked",
	).length;
	if (todos > 0) parts.push({ key: "todos", text: `todos=${todos}`, priority: 30 });

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

	if (tasks > 0) parts.push({ key: "tasks", text: `tasks=${tasks}`, priority: 40 });
	if (jobs > 0) parts.push({ key: "jobs", text: `jobs=${jobs}`, priority: 50 });
	if (fail > 0) parts.push({ key: "fail", text: `fail=${fail}`, priority: 5 });
	if (mcpOk > 0 || mcpConn > 0 || mcpErr > 0) {
		let mcp = `mcp=${mcpOk}`;
		if (mcpConn > 0) mcp += `~${mcpConn}`;
		if (mcpErr > 0) mcp += `!${mcpErr}`;
		// Errors stay; healthy-only mcp is lower priority when tight.
		parts.push({ key: "mcp", text: mcp, priority: mcpErr > 0 ? 15 : 70 });
	}
	if (checkpoints > 0) parts.push({ key: "rw", text: `rw=${checkpoints}`, priority: 80 });

	if (parts.length === 0) return undefined;

	const budget = Math.max(24, maxCols - 8);
	const ordered = [...parts].sort((a, b) => a.priority - b.priority);
	const kept: string[] = [];
	for (const part of ordered) {
		const candidate = kept.length === 0 ? part.text : `${kept.join(" ")} ${part.text}`;
		if (candidate.length > budget && kept.length > 0) continue;
		kept.push(part.text);
	}
	// Preserve a stable human order: fail, goal, plan, todos, tasks, jobs, mcp, rw
	const order = ["fail", "goal", "plan", "todos", "tasks", "jobs", "mcp", "rw"];
	const keptSet = new Set(kept);
	return parts
		.filter((p) => keptSet.has(p.text))
		.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
		.map((p) => p.text)
		.join(" ");
}

/** Exactly one status key `"qi"`. Clears when nothing to show. */
export function refreshFooter(ctx: { ui: Pick<ExtensionUIContext, "setStatus"> }, state: QiWorkflowState): void {
	ctx.ui.setStatus(QI_FOOTER_STATUS_KEY, buildFooterText(state));
}
