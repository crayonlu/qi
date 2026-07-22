import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import type { JobEntity, QiWorkflowState, TaskEntity, TodoItem } from "../domain/index.ts";
import { colorStatus } from "./status-color.ts";

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

/** Whether the board should be visible at all. */
export function hasActiveWork(state: QiWorkflowState): boolean {
	if (isActiveGoal(state)) return true;
	if (state.todos.some(isUnfinishedTodo)) return true;
	if (state.tasks.some(isActiveTask)) return true;
	if (state.jobs.some(isActiveJob)) return true;
	if (state.plan?.status === "ready") return true;
	return false;
}

function compactTodos(todos: TodoItem[]): string {
	const unfinished = todos.filter(isUnfinishedTodo).sort((a, b) => a.position - b.position);
	if (unfinished.length === 0) return "";
	const shown = unfinished.slice(0, 3).map((t) => {
		const mark = t.status === "in_progress" ? "*" : t.status === "blocked" ? "!" : "·";
		return `${mark}${t.text}`;
	});
	const extra = unfinished.length > 3 ? ` +${unfinished.length - 3}` : "";
	return `${shown.join(" · ")}${extra}`;
}

/**
 * Build board lines (max 4: goal, todos, task, job) plus optional plan-ready line.
 * Returns undefined when there is no active work (caller should hide the widget).
 */
export function buildBoardLines(state: QiWorkflowState, theme: Theme, collapsed: boolean): string[] | undefined {
	if (!hasActiveWork(state)) return undefined;

	const unfinished = state.todos.filter(isUnfinishedTodo);
	const activeTasks = state.tasks.filter(isActiveTask);
	const activeJobs = state.jobs.filter(isActiveJob);
	const planReady = state.plan?.status === "ready";

	if (collapsed) {
		const bits: string[] = [];
		if (state.goal && isActiveGoal(state)) {
			bits.push(colorStatus(theme, state.goal.status, `goal:${state.goal.status}`));
		}
		if (unfinished.length > 0) bits.push(theme.fg("muted", `todos=${unfinished.length}`));
		if (activeTasks.length > 0) bits.push(theme.fg("accent", `tasks=${activeTasks.length}`));
		if (activeJobs.length > 0) bits.push(theme.fg("accent", `jobs=${activeJobs.length}`));
		if (planReady) bits.push(theme.fg("success", "plan ready"));
		const summary = bits.length > 0 ? bits.join(" ") : theme.fg("dim", "qi");
		return [theme.fg("dim", "▸ ") + summary + theme.fg("dim", "  [/qi expand]")];
	}

	const lines: string[] = [];

	if (state.goal && isActiveGoal(state)) {
		const label = colorStatus(theme, state.goal.status, "goal");
		const obj = theme.fg("text", state.goal.objective);
		lines.push(`${label} ${obj}`);
	}

	if (unfinished.length > 0) {
		const compact = compactTodos(state.todos);
		lines.push(`${theme.fg("muted", "todos")} ${theme.fg("text", compact)}`);
	}

	if (activeTasks.length > 0) {
		const task = activeTasks[0]!;
		const more = activeTasks.length > 1 ? theme.fg("dim", ` +${activeTasks.length - 1}`) : "";
		lines.push(`${colorStatus(theme, task.status, "task")} ${theme.fg("text", task.goal)}${more}`);
	}

	if (activeJobs.length > 0) {
		const job = activeJobs[0]!;
		const more = activeJobs.length > 1 ? theme.fg("dim", ` +${activeJobs.length - 1}`) : "";
		lines.push(`${colorStatus(theme, job.status, "job")} ${theme.fg("text", job.name)}${more}`);
	}

	// Cap to 4 primary lines (goal/todos/task/job), keep newest/most relevant first.
	const primary = lines.slice(0, 4);

	if (planReady) {
		primary.push(theme.fg("success", "plan ready") + theme.fg("dim", ` · ${state.plan!.goal}`));
	}

	return primary.length > 0 ? primary : undefined;
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
		// Widget is non-capturing; expand/collapse via commands.
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
