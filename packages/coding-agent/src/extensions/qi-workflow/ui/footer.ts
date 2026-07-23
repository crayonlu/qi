/**
 * Single Qi footer status key — goal/plan/todos/tasks/jobs/agents/mcp/fail signals.
 * Never drops signals: attention-critical parts are ordered first so host
 * width truncation (if any) keeps what users must see. Icons + optional
 * tick frames strengthen live/alert states. Always icon+gap+label (rpiv);
 * spinner and status glyph are also gapped (never `⠹◐`).
 */

import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import { theme as appTheme, type Theme, type ThemeColor } from "../../../modes/interactive/theme/theme.ts";
import type { JobEntity, McpServerState, QiWorkflowState, TaskEntity } from "../domain/index.ts";
import { countActiveAgents } from "../vendor/subagents/agent-bridge.ts";
import { statusThemeColor } from "./status-color.ts";
import { alertFrame, goalIcon, ICON_GAP, ICONS, planIcon, spinFrame, withIcon } from "./status-icons.ts";

export const QI_FOOTER_STATUS_KEY = "qi";

/** Separator between footer chips — wider than icon↔label gap. */
export const FOOTER_CHIP_SEP = "  ";

/** Identity theme for unit tests / pre-initTheme. */
const PLAIN_THEME = {
	fg: (_color: ThemeColor, text: string) => text,
	bg: (_color: ThemeColor, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

function resolveTheme(th?: Theme): Theme {
	if (th) return th;
	try {
		// Probe interactive theme; throws before initTheme().
		void appTheme.fg("dim", "");
		return appTheme;
	} catch {
		return PLAIN_THEME;
	}
}
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
	if (countActiveAgents() > 0) return true;
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

/** Live spinner + status glyph with gap (never glued). */
function liveGlyph(th: Theme, tick: number, glyph: string, color: ThemeColor): string {
	return `${th.fg("warning", spinFrame(tick))}${ICON_GAP}${th.fg(color, glyph)}`;
}

function pulseGlyph(th: Theme, tick: number, glyph: string, color: ThemeColor): string {
	return `${th.fg("error", alertFrame(tick))}${ICON_GAP}${th.fg(color, glyph)}`;
}

function chip(th: Theme, icon: string, label: string, labelColor: ThemeColor): string {
	return withIcon(icon, th.fg(labelColor, label));
}

/**
 * Build footer text from all nonzero workflow signals.
 * Attention-critical tokens come first (never omitted).
 * @param tick - animation frame index when live/alert states are present
 */
export function buildFooterText(state: QiWorkflowState, tick = 0, th?: Theme): string | undefined {
	th = resolveTheme(th);
	const alert: string[] = [];
	const rest: string[] = [];

	const fail =
		state.tasks.filter(isFailedTask).length +
		state.jobs.filter(isFailedJob).length +
		state.workflows.filter((w) => w.status === "failed").length;
	if (fail > 0) {
		alert.push(chip(th, pulseGlyph(th, tick, ICONS.fail, "error"), `fail=${fail}`, "error"));
	}

	const goal = state.goal;
	if (goal && (goal.status === "active" || goal.status === "paused" || goal.status === "blocked")) {
		const color = statusThemeColor(goal.status);
		const icon =
			goal.status === "blocked"
				? pulseGlyph(th, tick, goalIcon(goal.status), color)
				: th.fg(color, goalIcon(goal.status));
		let label = `goal:${goal.status}`;
		if (goal.tokenBudget && goal.tokenBudget > 0) label += `(${goal.tokensUsed}/${goal.tokenBudget})`;
		else if (goal.tokensUsed > 0) label += `(${goal.tokensUsed})`;
		const g = chip(th, icon, label, color);
		if (goal.status === "blocked") alert.push(g);
		else rest.push(g);
	}

	const mcpOk = state.mcpServers.filter(isConnectedMcp).length;
	const mcpConn = state.mcpServers.filter(isConnectingMcp).length;
	const mcpErr = state.mcpServers.filter(isErrorMcp).length;
	if (mcpOk > 0 || mcpConn > 0 || mcpErr > 0) {
		const color = mcpErr > 0 ? "error" : mcpConn > 0 ? "accent" : "success";
		const icon =
			mcpErr > 0
				? pulseGlyph(th, tick, ICONS.mcpErr, color)
				: mcpConn > 0
					? liveGlyph(th, tick, ICONS.mcpConn, color)
					: th.fg(color, ICONS.mcpOk);
		let label = `mcp=${mcpOk}`;
		if (mcpConn > 0) label += `~${mcpConn}`;
		if (mcpErr > 0) label += `!${mcpErr}`;
		const mcp = chip(th, icon, label, color);
		if (mcpErr > 0) alert.push(mcp);
		else rest.push(mcp);
	}

	const plan = state.plan;
	if (plan && (plan.status === "draft" || plan.status === "ready" || plan.status === "executing")) {
		const color = statusThemeColor(plan.status);
		const icon =
			plan.status === "executing"
				? liveGlyph(th, tick, planIcon(plan.status), color)
				: th.fg(color, planIcon(plan.status));
		rest.push(chip(th, icon, `plan:${plan.status}`, color));
	}

	const blockedTodos = state.todos.filter((t) => t.status === "blocked").length;
	const inProgressTodos = state.todos.filter((t) => t.status === "in_progress").length;
	const todos = state.todos.filter(
		(t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked",
	).length;
	if (todos > 0) {
		const color = blockedTodos > 0 ? "error" : inProgressTodos > 0 ? "warning" : "muted";
		const glyph = blockedTodos > 0 ? ICONS.todoBlocked : inProgressTodos > 0 ? ICONS.todoActive : ICONS.todos;
		const icon = blockedTodos > 0 ? pulseGlyph(th, tick, glyph, color) : th.fg(color, glyph);
		const label = blockedTodos > 0 ? `todos=${todos}!${blockedTodos}` : `todos=${todos}`;
		const text = chip(th, icon, label, color);
		if (blockedTodos > 0) alert.push(text);
		else rest.push(text);
	}

	const agents = countActiveAgents();
	if (agents > 0) {
		rest.push(chip(th, liveGlyph(th, tick, ICONS.active, "thinkingText"), `agents=${agents}`, "thinkingText"));
	}

	const tasks = state.tasks.filter(isActiveTask).length;
	const runningTasks = state.tasks.filter((t) => t.status === "running").length;
	if (tasks > 0) {
		const color = runningTasks > 0 ? "accent" : "muted";
		const icon = runningTasks > 0 ? liveGlyph(th, tick, ICONS.tasks, color) : th.fg(color, ICONS.tasksIdle);
		rest.push(chip(th, icon, `tasks=${tasks}`, color));
	}

	const jobs = state.jobs.filter(isActiveJob).length;
	const liveJobs = state.jobs.filter((j) => j.status === "running" || j.status === "terminating").length;
	if (jobs > 0) {
		const color = liveJobs > 0 ? "warning" : "muted";
		const icon = liveJobs > 0 ? liveGlyph(th, tick, ICONS.jobs, color) : th.fg(color, ICONS.jobsIdle);
		rest.push(chip(th, icon, `jobs=${jobs}`, color));
	}

	const checkpoints = state.rewindCheckpoints.length;
	if (checkpoints > 0) {
		rest.push(chip(th, th.fg("dim", ICONS.rewind), `rw=${checkpoints}`, "dim"));
	}

	const parts = [...alert, ...rest];
	if (parts.length === 0) return undefined;
	return parts.join(FOOTER_CHIP_SEP);
}

/** Exactly one status key `"qi"`. Clears when nothing to show. */
export function refreshFooter(
	ctx: { ui: Pick<ExtensionUIContext, "setStatus"> },
	state: QiWorkflowState,
	tick = 0,
): void {
	ctx.ui.setStatus(QI_FOOTER_STATUS_KEY, buildFooterText(state, tick));
}
