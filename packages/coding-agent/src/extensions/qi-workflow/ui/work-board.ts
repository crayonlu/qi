/**
 * Build board lines for active Qi work (goal / plan / todos / tasks / jobs).
 * Collapsed mode uses /board expand — never a dead [/qi expand] hint.
 * Icons mark attention states; do not drop blocked/failed signals from chips.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import type { JobEntity, QiWorkflowState, TaskEntity, TodoItem } from "../domain/index.ts";
import { colorStatus } from "./status-color.ts";
import { goalIcon, ICONS, planIcon } from "./status-icons.ts";

export const QI_BOARD_WIDGET_KEY = "qi-board";

function isUnfinishedTodo(todo: TodoItem): boolean {
	return todo.status === "pending" || todo.status === "in_progress" || todo.status === "blocked";
}

function isActiveTask(task: TaskEntity): boolean {
	return task.status === "pending" || task.status === "running";
}

function isActiveJob(job: JobEntity): boolean {
	return job.status === "running" || job.status === "terminating";
}

function isActiveGoal(state: QiWorkflowState): boolean {
	const g = state.goal;
	return !!g && (g.status === "active" || g.status === "paused" || g.status === "blocked");
}

function isVisiblePlan(state: QiWorkflowState): boolean {
	const p = state.plan;
	return !!p && (p.status === "draft" || p.status === "ready" || p.status === "executing");
}

/** Whether the board should be visible at all. */
export function hasActiveWork(state: QiWorkflowState): boolean {
	if (isActiveGoal(state)) return true;
	if (state.todos.some(isUnfinishedTodo)) return true;
	if (state.tasks.some(isActiveTask)) return true;
	if (state.jobs.some(isActiveJob)) return true;
	if (isVisiblePlan(state)) return true;
	return false;
}

function formatTodoChip(t: TodoItem): string {
	const mark =
		t.status === "in_progress" ? ICONS.todoActive : t.status === "blocked" ? ICONS.todoBlocked : ICONS.todos;
	const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.text;
	const deps = t.blockedBy && t.blockedBy.length > 0 ? `${ICONS.rewind}${t.blockedBy.join(",")}` : "";
	return `${mark}${label}${deps}`;
}

function compactTodos(todos: TodoItem[]): string {
	const unfinished = todos.filter(isUnfinishedTodo).sort((a, b) => {
		const rank = (s: string) => (s === "blocked" ? 0 : s === "in_progress" ? 1 : 2);
		return rank(a.status) - rank(b.status) || a.position - b.position;
	});
	if (unfinished.length === 0) return "";
	// Keep every unfinished chip (blocked first). Width truncate only at render.
	return unfinished.map(formatTodoChip).join(" · ");
}

function goalUsageBits(state: QiWorkflowState, theme: Theme): string {
	const g = state.goal;
	if (!g || !isActiveGoal(state)) return "";
	const bits: string[] = [];
	if (g.tokenBudget && g.tokenBudget > 0) {
		bits.push(`${g.tokensUsed}/${g.tokenBudget} tok`);
	} else if (g.tokensUsed > 0) {
		bits.push(`${g.tokensUsed} tok`);
	}
	if (g.vendorStatus && g.vendorStatus !== g.status) bits.push(g.vendorStatus);
	return bits.length ? theme.fg("dim", ` (${bits.join(" · ")})`) : "";
}

/**
 * Build board lines (goal, plan, todos, task, job).
 * Returns undefined when there is no active work (caller should hide the widget).
 */
export function buildBoardLines(state: QiWorkflowState, theme: Theme, collapsed: boolean): string[] | undefined {
	if (!hasActiveWork(state)) return undefined;

	const unfinished = state.todos.filter(isUnfinishedTodo);
	const activeTasks = state.tasks.filter(isActiveTask);
	const activeJobs = state.jobs.filter(isActiveJob);
	const plan = state.plan;
	const planVisible = isVisiblePlan(state);

	if (collapsed) {
		const bits: string[] = [];
		if (state.goal && isActiveGoal(state)) {
			bits.push(colorStatus(theme, state.goal.status, `${goalIcon(state.goal.status)}goal:${state.goal.status}`));
		}
		if (planVisible && plan) {
			bits.push(theme.fg("muted", `${planIcon(plan.status)}plan:${plan.status}`));
		}
		if (unfinished.length > 0) {
			const blocked = unfinished.filter((t) => t.status === "blocked").length;
			const icon = blocked > 0 ? ICONS.todoBlocked : ICONS.todos;
			bits.push(theme.fg(blocked > 0 ? "error" : "muted", `${icon}todos=${unfinished.length}`));
		}
		if (activeTasks.length > 0) {
			bits.push(theme.fg("accent", `${ICONS.tasks}tasks=${activeTasks.length}`));
		}
		if (activeJobs.length > 0) {
			bits.push(theme.fg("accent", `${ICONS.jobs}jobs=${activeJobs.length}`));
		}
		const summary = bits.length > 0 ? bits.join(" ") : theme.fg("dim", "qi");
		return [theme.fg("dim", "▸ ") + summary + theme.fg("dim", "  [/board expand]")];
	}

	const lines: string[] = [];

	if (state.goal && isActiveGoal(state)) {
		const label = colorStatus(theme, state.goal.status, `${goalIcon(state.goal.status)}goal`);
		const obj = theme.fg("text", state.goal.objective);
		lines.push(`${label} ${obj}${goalUsageBits(state, theme)}`);
		if (state.goal.blockReason) {
			lines.push(theme.fg("error", `  ${ICONS.fail} ${state.goal.blockReason}`));
		}
	}

	if (planVisible && plan) {
		const planColor = plan.status === "ready" ? "success" : plan.status === "executing" ? "accent" : "muted";
		lines.push(
			`${theme.fg(planColor, `${planIcon(plan.status)}plan:${plan.status}`)} ${theme.fg("text", plan.goal)}` +
				theme.fg("dim", "  [/plan execute · /plan ready]"),
		);
	}

	if (unfinished.length > 0) {
		const compact = compactTodos(state.todos);
		lines.push(`${theme.fg("muted", `${ICONS.todos}todos`)} ${theme.fg("text", compact)}`);
	}

	if (activeTasks.length > 0) {
		const task = activeTasks[0]!;
		const more = activeTasks.length > 1 ? theme.fg("dim", ` +${activeTasks.length - 1}`) : "";
		lines.push(`${colorStatus(theme, task.status, `${ICONS.tasks}task`)} ${theme.fg("text", task.goal)}${more}`);
	}

	if (activeJobs.length > 0) {
		const job = activeJobs[0]!;
		const more = activeJobs.length > 1 ? theme.fg("dim", ` +${activeJobs.length - 1}`) : "";
		lines.push(`${colorStatus(theme, job.status, `${ICONS.jobs}job`)} ${theme.fg("text", job.name)}${more}`);
	}

	return lines.length > 0 ? lines : undefined;
}

class QiWorkBoard implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private unsubscribe: (() => void) | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tui: TUI, theme: Theme, controller: WorkflowController) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.unsubscribe = controller.subscribe(() => {
			this.invalidate();
			this.tui.requestRender();
		});
	}

	handleInput(_data: string): void {
		// Non-capturing widget; expand/collapse via /board.
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const state = this.controller.getState();
		const raw = buildBoardLines(state, this.theme, state.boardCollapsed);
		const lines = (raw ?? []).map((line) => truncateToWidth(line, width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

/** Factory for `ctx.ui.setWidget(..., factory, { placement: "aboveEditor" })`. */
export function createQiWorkBoard(
	controller: WorkflowController,
): (tui: TUI, theme: Theme) => Component & { dispose?(): void } {
	return (tui, theme) => new QiWorkBoard(tui, theme, controller);
}

/**
 * Refresh / show / hide the aboveEditor work board.
 * Hides entirely when there is no active work.
 */
export function refreshBoard(ctx: { ui: Pick<ExtensionUIContext, "setWidget"> }, controller: WorkflowController): void {
	const state = controller.getState();
	if (!hasActiveWork(state)) {
		ctx.ui.setWidget(QI_BOARD_WIDGET_KEY, undefined);
		return;
	}
	ctx.ui.setWidget(QI_BOARD_WIDGET_KEY, createQiWorkBoard(controller), { placement: "aboveEditor" });
}
