import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import {
	cancelTodoViaVendor,
	completeTodoViaVendor,
	executePlanToTodosViaVendor,
	removeTodoViaVendor,
	startTodoViaVendor,
} from "../adapters/index.ts";
import type { WorkflowController } from "../controller.ts";
import {
	cancelJob,
	cancelTask,
	cancelWorkflow,
	createWorkflow,
	discardPlan,
	executePlanToWorkflow,
	type JobEntity,
	markPlanReady,
	moveTodo,
	type Plan,
	type QiWorkflowState,
	type TaskEntity,
	type TodoItem,
	type WorkflowEntity,
} from "../domain/index.ts";
import { jobManager } from "../runtime/job-manager.ts";
import { colorStatus } from "./status-color.ts";

export type DashboardTab = "plan" | "todo" | "workflow" | "task" | "job";

const TABS: DashboardTab[] = ["plan", "todo", "workflow", "task", "job"];
const TAB_LABEL: Record<DashboardTab, string> = {
	plan: "Plan",
	todo: "Todo",
	workflow: "Workflow",
	task: "Task",
	job: "Job",
};

const CENTER_OVERLAY = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 60,
	maxHeight: "85%" as const,
	margin: 1,
};

function termCols(): number {
	return process.stdout.columns ?? 80;
}

function shortId(id: string): string {
	const parts = id.split("_");
	return parts[parts.length - 1]?.slice(0, 8) ?? id.slice(0, 8);
}

function formatTime(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type ListItem = {
	id: string;
	status: string;
	title: string;
	meta?: string;
};

function itemsForTab(state: QiWorkflowState, tab: DashboardTab): ListItem[] {
	switch (tab) {
		case "plan":
			return state.plan && state.plan.status !== "discarded"
				? [
						{
							id: state.plan.id,
							status: state.plan.status,
							title: state.plan.goal,
							meta: `rev ${state.plan.revision}`,
						},
					]
				: [];
		case "todo":
			return state.todos
				.slice()
				.sort((a, b) => a.position - b.position)
				.map((t) => ({
					id: t.id,
					status: t.status,
					title: t.text,
					meta: `#${t.position}`,
				}));
		case "workflow":
			return state.workflows.map((w) => ({
				id: w.id,
				status: w.status,
				title: w.goal,
				meta: w.mode,
			}));
		case "task":
			return state.tasks.map((t) => ({
				id: t.id,
				status: t.status,
				title: t.goal,
				meta: t.workflowId ? `wf ${shortId(t.workflowId)}` : undefined,
			}));
		case "job":
			return state.jobs.map((j) => ({
				id: j.id,
				status: j.status,
				title: j.name,
				meta: j.pid ? `pid ${j.pid}` : undefined,
			}));
	}
}

class WorkDashboard implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private ctx: { ui: ExtensionUIContext };
	private done: () => void;
	private tab: DashboardTab;
	private index = 0;
	private oneColumnDetail = false;
	private message = "";
	private cachedWidth?: number;
	private cachedLines?: string[];
	private unsubscribe: (() => void) | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		controller: WorkflowController,
		ctx: { ui: ExtensionUIContext },
		initialTab: DashboardTab,
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.ctx = ctx;
		this.tab = initialTab;
		this.done = done;
		this.unsubscribe = controller.subscribe(() => {
			this.clampIndex();
			this.invalidate();
			this.tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	private state(): QiWorkflowState {
		return this.controller.getState();
	}

	private items(): ListItem[] {
		return itemsForTab(this.state(), this.tab);
	}

	private clampIndex(): void {
		const n = this.items().length;
		if (n === 0) this.index = 0;
		else this.index = Math.min(this.index, n - 1);
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private setMessage(msg: string): void {
		this.message = msg;
		this.refresh();
	}

	private applyOrNotify<T>(
		transition: (
			state: QiWorkflowState,
		) => { ok: true; value: T; state: QiWorkflowState } | { ok: false; error: string; state: QiWorkflowState },
		okMsg: string,
	): void {
		const result = this.controller.apply(transition);
		if (!result.ok) {
			this.setMessage(result.error);
			this.ctx.ui.notify(result.error, "error");
			return;
		}
		this.setMessage(okMsg);
	}

	private async runAction(): Promise<void> {
		const state = this.state();
		const items = this.items();
		const item = items[this.index];

		if (this.tab === "plan") {
			const plan = state.plan;
			if (!plan || plan.status === "discarded") {
				this.setMessage("No active plan");
				return;
			}
			if (plan.status === "draft") {
				const action = await this.ctx.ui.select("Plan actions", ["Mark ready", "Discard", "Cancel"]);
				if (!action || action === "Cancel") return;
				if (action === "Mark ready") {
					this.applyOrNotify((s) => markPlanReady(s), "Plan marked ready");
				} else {
					this.applyOrNotify((s) => discardPlan(s), "Plan discarded");
				}
				return;
			}
			if (plan.status === "ready") {
				const action = await this.ctx.ui.select("Execute plan", [
					"Create ordered Todos",
					"Create Workflow",
					"Discard",
					"Cancel",
				]);
				if (!action || action === "Cancel") return;
				if (action === "Create ordered Todos") {
					this.applyOrNotify((s) => executePlanToTodosViaVendor(s), "Plan → todos");
				} else if (action === "Create Workflow") {
					this.applyOrNotify((s) => {
						if (!s.plan || s.plan.status !== "ready") {
							return { ok: false, error: "Plan must be ready to execute", state: s };
						}
						const created = createWorkflow(s, s.plan.goal, "chain", false, s.plan.sections.steps);
						if (!created.ok) return created;
						return executePlanToWorkflow(created.state, created.value);
					}, "Plan → workflow");
				} else if (action === "Discard") {
					this.applyOrNotify((s) => discardPlan(s), "Plan discarded");
				}
				return;
			}
			this.setMessage(`No actions for status ${plan.status}`);
			return;
		}

		if (!item) {
			this.setMessage("Nothing selected");
			return;
		}

		if (this.tab === "todo") {
			const action = await this.ctx.ui.select(`Todo: ${item.title}`, [
				"Start",
				"Complete",
				"Cancel",
				"Move up",
				"Move down",
				"Remove",
				"Back",
			]);
			if (!action || action === "Back") return;
			if (action === "Start") this.applyOrNotify((s) => startTodoViaVendor(s, item.id), "Todo started");
			else if (action === "Complete") this.applyOrNotify((s) => completeTodoViaVendor(s, item.id), "Todo completed");
			else if (action === "Cancel") this.applyOrNotify((s) => cancelTodoViaVendor(s, item.id), "Todo cancelled");
			else if (action === "Move up") {
				const todo = this.state().todos.find((t) => t.id === item.id);
				if (todo) this.applyOrNotify((s) => moveTodo(s, item.id, Math.max(0, todo.position - 1)), "Moved up");
			} else if (action === "Move down") {
				const todo = this.state().todos.find((t) => t.id === item.id);
				if (todo) this.applyOrNotify((s) => moveTodo(s, item.id, todo.position + 1), "Moved down");
			} else if (action === "Remove") this.applyOrNotify((s) => removeTodoViaVendor(s, item.id), "Todo removed");
			return;
		}

		if (this.tab === "workflow") {
			const ok = await this.ctx.ui.confirm("Cancel workflow", `Cancel workflow "${item.title}"?`);
			if (!ok) return;
			this.applyOrNotify((s) => cancelWorkflow(s, item.id), "Workflow cancelled");
			return;
		}

		if (this.tab === "task") {
			const ok = await this.ctx.ui.confirm("Cancel task", `Cancel task "${item.title}"?`);
			if (!ok) return;
			this.applyOrNotify((s) => cancelTask(s, item.id), "Task cancelled");
			return;
		}

		if (this.tab === "job") {
			const action = await this.ctx.ui.select(`Job: ${item.title}`, [
				"View logs",
				"Cancel",
				"Clear finished",
				"Back",
			]);
			if (!action || action === "Back") return;
			if (action === "View logs") {
				try {
					const logs = jobManager.logs(item.id, 40);
					this.setMessage(logs.trim() ? logs.slice(0, 600) : "(no output yet)");
					this.refresh();
				} catch (err) {
					this.setMessage(err instanceof Error ? err.message : String(err));
					this.refresh();
				}
				return;
			}
			if (action === "Clear finished") {
				const n = jobManager.clearFinished();
				this.setMessage(`Cleared ${n} finished job(s)`);
				this.refresh();
				return;
			}
			if (action === "Cancel") {
				const ok = await this.ctx.ui.confirm("Cancel job", `Cancel job "${item.title}"?`);
				if (!ok) return;
				this.applyOrNotify((s) => cancelJob(s, item.id), "Job cancel requested");
			}
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.oneColumnDetail) {
				this.oneColumnDetail = false;
				this.refresh();
				return;
			}
			this.done();
			return;
		}

		if (matchesKey(data, "tab") || data === "]") {
			const i = TABS.indexOf(this.tab);
			this.tab = TABS[(i + 1) % TABS.length]!;
			this.index = 0;
			this.oneColumnDetail = false;
			this.refresh();
			return;
		}
		if (matchesKey(data, "shift+tab") || data === "[") {
			const i = TABS.indexOf(this.tab);
			this.tab = TABS[(i + TABS.length - 1) % TABS.length]!;
			this.index = 0;
			this.oneColumnDetail = false;
			this.refresh();
			return;
		}

		const items = this.items();
		if (matchesKey(data, "up")) {
			this.index = Math.max(0, this.index - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			this.index = Math.min(Math.max(0, items.length - 1), this.index + 1);
			this.refresh();
			return;
		}

		const cols = termCols();
		if (cols < 80 && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "l" || data === "L")) {
			if (!this.oneColumnDetail && items.length > 0) {
				this.oneColumnDetail = true;
				this.refresh();
				return;
			}
		}

		if (data === "a" || data === "A" || matchesKey(data, "enter") || matchesKey(data, "return")) {
			void this.runAction();
		}
	}

	private renderPlanDetail(plan: Plan, width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		lines.push(truncateToWidth(`${colorStatus(th, plan.status, plan.status)} ${th.fg("text", plan.goal)}`, width));
		lines.push(
			truncateToWidth(
				th.fg("dim", `id ${shortId(plan.id)} · rev ${plan.revision} · ${formatTime(plan.updatedAt)}`),
				width,
			),
		);
		lines.push("");
		const sections: Array<[string, string[]]> = [
			["discoveries", plan.sections.discoveries],
			["assumptions", plan.sections.assumptions],
			["decisions", plan.sections.decisions],
			["steps", plan.sections.steps],
			["verification", plan.sections.verification],
			["unresolved", plan.sections.unresolvedQuestions],
		];
		for (const [name, values] of sections) {
			lines.push(truncateToWidth(th.fg("accent", name), width));
			if (values.length === 0) {
				lines.push(truncateToWidth(th.fg("dim", "  (empty)"), width));
			} else {
				for (const v of values.slice(0, 12)) {
					lines.push(...wrapTextWithAnsi(th.fg("text", `  · ${v}`), width));
				}
				if (values.length > 12) {
					lines.push(truncateToWidth(th.fg("dim", `  … +${values.length - 12}`), width));
				}
			}
		}
		return lines;
	}

	private renderTodoDetail(todo: TodoItem, width: number): string[] {
		const th = this.theme;
		const lines = [
			truncateToWidth(`${colorStatus(th, todo.status, todo.status)} ${th.fg("text", todo.text)}`, width),
			truncateToWidth(
				th.fg("dim", `id ${shortId(todo.id)} · pos ${todo.position}${todo.owner ? ` · owner ${todo.owner}` : ""}`),
				width,
			),
		];
		if (todo.description) lines.push(...wrapTextWithAnsi(th.fg("muted", todo.description), width));
		if (todo.activeForm) lines.push(truncateToWidth(th.fg("accent", `active: ${todo.activeForm}`), width));
		if (todo.blockedBy && todo.blockedBy.length > 0) {
			lines.push(truncateToWidth(th.fg("warning", `blockedBy: ${todo.blockedBy.join(", ")}`), width));
		}
		if (todo.blockReason) lines.push(...wrapTextWithAnsi(th.fg("error", `blocked: ${todo.blockReason}`), width));
		if (todo.verification) lines.push(...wrapTextWithAnsi(th.fg("success", `ok: ${todo.verification}`), width));
		return lines;
	}

	private renderJobDetail(job: JobEntity, width: number): string[] {
		const th = this.theme;
		const lines = [
			truncateToWidth(`${colorStatus(th, job.status, job.status)} ${th.fg("text", job.name)}`, width),
			truncateToWidth(th.fg("muted", job.command), width),
			truncateToWidth(
				th.fg(
					"dim",
					`cwd ${job.cwd}${job.pid ? ` · pid ${job.pid}` : ""}${job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ""} · bytes ${job.outputBytes}`,
				),
				width,
			),
		];
		if (job.logPath) lines.push(truncateToWidth(th.fg("dim", `log ${job.logPath}`), width));
		return lines;
	}

	private renderWorkflowDetail(wf: WorkflowEntity, width: number): string[] {
		const th = this.theme;
		return [
			truncateToWidth(`${colorStatus(th, wf.status, wf.status)} ${th.fg("text", wf.goal)}`, width),
			truncateToWidth(th.fg("dim", `mode ${wf.mode} · tasks ${wf.taskIds.length} · bg ${wf.background}`), width),
			...(wf.error ? wrapTextWithAnsi(th.fg("error", wf.error), width) : []),
			...(wf.resultSummary ? wrapTextWithAnsi(th.fg("muted", wf.resultSummary), width) : []),
		];
	}

	private renderTaskDetail(task: TaskEntity, width: number): string[] {
		const th = this.theme;
		return [
			truncateToWidth(`${colorStatus(th, task.status, task.status)} ${th.fg("text", task.goal)}`, width),
			truncateToWidth(
				th.fg(
					"dim",
					`id ${shortId(task.id)}${task.childSessionId ? ` · child ${shortId(task.childSessionId)}` : ""}`,
				),
				width,
			),
			...(task.error ? wrapTextWithAnsi(th.fg("error", task.error), width) : []),
			...(task.resultSummary ? wrapTextWithAnsi(th.fg("muted", task.resultSummary), width) : []),
		];
	}

	private renderDetail(width: number): string[] {
		const state = this.state();
		const items = this.items();
		const item = items[this.index];
		if (!item) return [this.theme.fg("dim", "Nothing selected")];

		switch (this.tab) {
			case "plan":
				return state.plan ? this.renderPlanDetail(state.plan, width) : [this.theme.fg("dim", "No plan")];
			case "todo": {
				const todo = state.todos.find((t) => t.id === item.id);
				return todo ? this.renderTodoDetail(todo, width) : [this.theme.fg("dim", "Missing")];
			}
			case "workflow": {
				const wf = state.workflows.find((w) => w.id === item.id);
				return wf ? this.renderWorkflowDetail(wf, width) : [this.theme.fg("dim", "Missing")];
			}
			case "task": {
				const task = state.tasks.find((t) => t.id === item.id);
				return task ? this.renderTaskDetail(task, width) : [this.theme.fg("dim", "Missing")];
			}
			case "job": {
				const job = state.jobs.find((j) => j.id === item.id);
				return job ? this.renderJobDetail(job, width) : [this.theme.fg("dim", "Missing")];
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const w = Math.max(1, width);
		const lines: string[] = [];
		const items = this.items();

		lines.push(th.fg("accent", "─".repeat(w)));
		const tabBar = TABS.map((t) => {
			const label = TAB_LABEL[t];
			return t === this.tab ? th.fg("accent", `[${label}]`) : th.fg("dim", label);
		}).join(" ");
		lines.push(truncateToWidth(tabBar, w));
		lines.push("");

		const wide = w >= 80;

		if (this.oneColumnDetail) {
			lines.push(...this.renderDetail(w));
		} else if (wide) {
			const listWidth = Math.min(40, Math.floor(w * 0.42));
			const detailWidth = Math.max(20, w - listWidth - 3);
			const maxRows = Math.max(1, Math.min(items.length || 1, 14));
			const start = items.length === 0 ? 0 : Math.max(0, Math.min(this.index - 5, items.length - maxRows));

			if (items.length === 0) {
				const left = truncateToWidth(th.fg("dim", "  (empty)"), listWidth);
				const rightLines = this.renderDetail(detailWidth);
				lines.push(truncateToWidth(`${left} │ ${rightLines[0] ?? ""}`, w));
				for (let i = 1; i < rightLines.length; i++) {
					lines.push(truncateToWidth(`${" ".repeat(listWidth)} │ ${rightLines[i]}`, w));
				}
			} else {
				const detailLines = this.renderDetail(detailWidth);
				for (let row = 0; row < Math.max(maxRows, detailLines.length); row++) {
					const i = start + row;
					let left = " ".repeat(listWidth);
					if (i < items.length && row < maxRows) {
						const it = items[i]!;
						const focused = i === this.index;
						const prefix = focused ? th.fg("accent", "> ") : "  ";
						left = truncateToWidth(
							prefix +
								colorStatus(th, it.status, "●") +
								" " +
								th.fg(focused ? "accent" : "text", it.title) +
								(it.meta ? th.fg("dim", ` ${it.meta}`) : ""),
							listWidth,
						);
					}
					const right = detailLines[row] ?? "";
					lines.push(truncateToWidth(`${left} │ ${right}`, w));
				}
			}
		} else {
			// 60-79: one-column list; Enter opens detail
			if (items.length === 0) {
				lines.push(truncateToWidth(th.fg("dim", "  (empty)"), w));
			} else {
				for (let i = 0; i < items.length; i++) {
					const it = items[i]!;
					const focused = i === this.index;
					const prefix = focused ? th.fg("accent", "> ") : "  ";
					lines.push(
						truncateToWidth(
							`${prefix}${colorStatus(th, it.status, "●")} ${th.fg(focused ? "accent" : "text", it.title)}`,
							w,
						),
					);
				}
			}
		}

		if (this.message) {
			lines.push("");
			lines.push(truncateToWidth(th.fg("warning", this.message), w));
		}

		lines.push("");
		const hints = wide
			? "Tab/[ ] tabs · ↑↓ · a/Enter action · Esc close"
			: "Tab tabs · ↑↓ · Enter detail · a action · Esc back/close";
		lines.push(truncateToWidth(th.fg("dim", hints), w));
		lines.push(th.fg("accent", "─".repeat(w)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

async function narrowDashboardSelect(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	initialTab: DashboardTab,
): Promise<void> {
	let tab = initialTab;
	for (;;) {
		const tabChoice = await ctx.ui.select("Qi dashboard", [
			...TABS.map((t) => (t === tab ? `• ${TAB_LABEL[t]}` : TAB_LABEL[t])),
			"Close",
		]);
		if (!tabChoice || tabChoice === "Close") return;
		const matched = TABS.find((t) => tabChoice.includes(TAB_LABEL[t]));
		if (matched) tab = matched;

		const state = controller.getState();
		const items = itemsForTab(state, tab);
		if (items.length === 0) {
			ctx.ui.notify(`No ${TAB_LABEL[tab]} items`, "info");
			continue;
		}
		const choice = await ctx.ui.select(
			TAB_LABEL[tab],
			items.map((it) => `[${it.status}] ${it.title}`),
		);
		if (!choice) continue;
		const item = items.find((it) => choice.includes(it.title));
		if (!item) continue;

		if (tab === "plan") {
			const plan = state.plan;
			if (!plan) continue;
			if (plan.status === "draft") {
				const action = await ctx.ui.select("Plan", ["Mark ready", "Discard", "Back"]);
				if (action === "Mark ready") {
					const r = controller.apply((s) => markPlanReady(s));
					ctx.ui.notify(r.ok ? "Plan ready" : r.error, r.ok ? "info" : "error");
				} else if (action === "Discard") {
					const r = controller.apply((s) => discardPlan(s));
					ctx.ui.notify(r.ok ? "Discarded" : r.error, r.ok ? "info" : "error");
				}
			} else if (plan.status === "ready") {
				const action = await ctx.ui.select("Execute plan", ["Create ordered Todos", "Create Workflow", "Back"]);
				if (action === "Create ordered Todos") {
					const r = controller.apply((s) => executePlanToTodosViaVendor(s));
					ctx.ui.notify(r.ok ? "Plan → todos" : r.error, r.ok ? "info" : "error");
				} else if (action === "Create Workflow") {
					const r = controller.apply((s) => {
						if (!s.plan || s.plan.status !== "ready") {
							return { ok: false as const, error: "Plan must be ready", state: s };
						}
						const created = createWorkflow(s, s.plan.goal, "chain", false, s.plan.sections.steps);
						if (!created.ok) return created;
						return executePlanToWorkflow(created.state, created.value);
					});
					ctx.ui.notify(r.ok ? "Plan → workflow" : r.error, r.ok ? "info" : "error");
				}
			}
			continue;
		}

		if (tab === "todo") {
			const action = await ctx.ui.select(item.title, ["Start", "Complete", "Cancel", "Remove", "Back"]);
			if (!action || action === "Back") continue;
			const r =
				action === "Start"
					? controller.apply((s) => startTodoViaVendor(s, item.id))
					: action === "Complete"
						? controller.apply((s) => completeTodoViaVendor(s, item.id))
						: action === "Cancel"
							? controller.apply((s) => cancelTodoViaVendor(s, item.id))
							: controller.apply((s) => removeTodoViaVendor(s, item.id));
			ctx.ui.notify(r.ok ? action : r.error, r.ok ? "info" : "error");
			continue;
		}

		const label = tab === "workflow" ? "Cancel workflow" : tab === "task" ? "Cancel task" : "Cancel job";
		const ok = await ctx.ui.confirm(label, `${label}: ${item.title}?`);
		if (!ok) continue;
		const r =
			tab === "workflow"
				? controller.apply((s) => cancelWorkflow(s, item.id))
				: tab === "task"
					? controller.apply((s) => cancelTask(s, item.id))
					: controller.apply((s) => cancelJob(s, item.id));
		ctx.ui.notify(r.ok ? "Cancelled" : r.error, r.ok ? "info" : "error");
	}
}

/**
 * Open QiWorkDashboard center overlay.
 * width >= 80: list + details; 60-79: one-column; <60: ctx.ui.select fallback.
 */
export async function openDashboard(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	initialTab: DashboardTab = "todo",
): Promise<void> {
	if (termCols() < 60) {
		await narrowDashboardSelect(ctx, controller, initialTab);
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new WorkDashboard(tui, theme, controller, ctx, initialTab, done),
		{ overlay: true, overlayOptions: CENTER_OVERLAY },
	);
}
