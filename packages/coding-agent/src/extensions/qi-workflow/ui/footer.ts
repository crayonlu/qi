/**
 * Single Qi footer status key — goal/plan/todos/tasks/jobs/mcp/fail signals.
 * Never drops signals: attention-critical parts are ordered first so host
 * width truncation (if any) keeps what users must see. Icons + optional
 * tick frames strengthen live/alert states.
 */

import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { JobEntity, McpServerState, QiWorkflowState, TaskEntity } from "../domain/index.ts";
import { alertFrame, goalIcon, ICONS, planIcon, spinFrame } from "./status-icons.ts";

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

/** Whether footer should animate (running / connecting / alerts). */
export function footerNeedsAnimation(state: QiWorkflowState): boolean {
	if (state.goal?.status === "blocked") return true;
	if (state.plan?.status === "executing") return true;
	if (state.todos.some((t) => t.status === "blocked" || t.status === "in_progress")) return true;
	if (state.tasks.some((t) => t.status === "running")) return true;
	if (state.jobs.some((j) => j.status === "running" || j.status === "terminating")) return true;
	if (state.mcpServers.some(isConnectingMcp) || state.mcpServers.some(isErrorMcp)) return true;
	if (
		state.tasks.some(isFailedTask) ||
		state.jobs.some(isFailedJob) ||
		state.workflows.some((w) => w.status === "failed")
	) {
		return true;
	}
	return false;
}

/**
 * Build footer text from all nonzero workflow signals.
 * Attention-critical tokens come first (never omitted).
 * @param tick - animation frame index when live/alert states are present
 */
export function buildFooterText(state: QiWorkflowState, tick = 0): string | undefined {
	const alert: string[] = [];
	const rest: string[] = [];
	const live = spinFrame(tick);
	const pulse = alertFrame(tick);

	const fail =
		state.tasks.filter(isFailedTask).length +
		state.jobs.filter(isFailedJob).length +
		state.workflows.filter((w) => w.status === "failed").length;
	if (fail > 0) alert.push(`${pulse}${ICONS.fail}fail=${fail}`);

	const goal = state.goal;
	if (goal && (goal.status === "active" || goal.status === "paused" || goal.status === "blocked")) {
		const icon = goal.status === "blocked" ? `${pulse}${goalIcon(goal.status)}` : goalIcon(goal.status);
		let g = `${icon}goal:${goal.status}`;
		if (goal.tokenBudget && goal.tokenBudget > 0) g += `(${goal.tokensUsed}/${goal.tokenBudget})`;
		else if (goal.tokensUsed > 0) g += `(${goal.tokensUsed})`;
		if (goal.status === "blocked") alert.push(g);
		else rest.push(g);
	}

	const mcpOk = state.mcpServers.filter(isConnectedMcp).length;
	const mcpConn = state.mcpServers.filter(isConnectingMcp).length;
	const mcpErr = state.mcpServers.filter(isErrorMcp).length;
	if (mcpOk > 0 || mcpConn > 0 || mcpErr > 0) {
		let mcp = `${mcpErr > 0 ? `${pulse}${ICONS.mcpErr}` : mcpConn > 0 ? `${live}${ICONS.mcpConn}` : ICONS.mcpOk}mcp=${mcpOk}`;
		if (mcpConn > 0) mcp += `~${mcpConn}`;
		if (mcpErr > 0) mcp += `!${mcpErr}`;
		if (mcpErr > 0) alert.push(mcp);
		else rest.push(mcp);
	}

	const plan = state.plan;
	if (plan && (plan.status === "draft" || plan.status === "ready" || plan.status === "executing")) {
		const icon = plan.status === "executing" ? `${live}${planIcon(plan.status)}` : planIcon(plan.status);
		rest.push(`${icon}plan:${plan.status}`);
	}

	const blockedTodos = state.todos.filter((t) => t.status === "blocked").length;
	const todos = state.todos.filter(
		(t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked",
	).length;
	if (todos > 0) {
		const icon = blockedTodos > 0 ? `${pulse}${ICONS.todoBlocked}` : ICONS.todos;
		const text = blockedTodos > 0 ? `${icon}todos=${todos}!${blockedTodos}` : `${icon}todos=${todos}`;
		if (blockedTodos > 0) alert.push(text);
		else rest.push(text);
	}

	const tasks = state.tasks.filter(isActiveTask).length;
	const runningTasks = state.tasks.filter((t) => t.status === "running").length;
	if (tasks > 0) {
		rest.push(`${runningTasks > 0 ? live : ""}${ICONS.tasks}tasks=${tasks}`);
	}

	const jobs = state.jobs.filter(isActiveJob).length;
	const liveJobs = state.jobs.filter((j) => j.status === "running" || j.status === "terminating").length;
	if (jobs > 0) {
		rest.push(`${liveJobs > 0 ? live : ""}${ICONS.jobs}jobs=${jobs}`);
	}

	const checkpoints = state.rewindCheckpoints.length;
	if (checkpoints > 0) rest.push(`${ICONS.rewind}rw=${checkpoints}`);

	const parts = [...alert, ...rest];
	if (parts.length === 0) return undefined;
	return parts.join(" ");
}

/** Exactly one status key `"qi"`. Clears when nothing to show. */
export function refreshFooter(
	ctx: { ui: Pick<ExtensionUIContext, "setStatus"> },
	state: QiWorkflowState,
	tick = 0,
): void {
	ctx.ui.setStatus(QI_FOOTER_STATUS_KEY, buildFooterText(state, tick));
}
