/**
 * Agent View — Claude Code–style live inspection of blocking + detached subagents.
 * Roster + detail pane with rpiv tree chrome; /agents opens this overlay.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import {
	type ForegroundRun,
	listForegroundRuns,
	listStatefulAgents,
	subscribeAgentBridge,
} from "../vendor/subagents/agent-bridge.ts";
import type { ManagedAgent } from "../vendor/subagents/registry.ts";
import { CENTER_OVERLAY } from "./layout.ts";
import { colorStatus } from "./status-color.ts";
import { ICONS, spinFrame, statusGlyph, withIcon } from "./status-icons.ts";

type RosterItem =
	| { key: string; kind: "stateful"; agent: ManagedAgent }
	| { key: string; kind: "foreground"; run: ForegroundRun };

function shortId(id: string): string {
	const parts = id.split(/[_-]/);
	const last = parts[parts.length - 1] ?? id;
	return last.slice(0, 8);
}

function collectRoster(): RosterItem[] {
	const items: RosterItem[] = [];
	for (const run of listForegroundRuns()) {
		items.push({ key: `fg:${run.id}`, kind: "foreground", run });
	}
	for (const agent of listStatefulAgents(true)) {
		items.push({ key: `sa:${agent.id}`, kind: "stateful", agent });
	}
	items.sort((a, b) => {
		const au = a.kind === "foreground" ? a.run.updatedAt : a.agent.updatedAt;
		const bu = b.kind === "foreground" ? b.run.updatedAt : b.agent.updatedAt;
		return bu - au;
	});
	return items;
}

function itemState(item: RosterItem): string {
	return item.kind === "foreground" ? item.run.state : item.agent.state;
}

function itemLabel(item: RosterItem): string {
	if (item.kind === "foreground") {
		return `${item.run.label} [${item.run.mode}]`;
	}
	return `${item.agent.agent} ${shortId(item.agent.id)}`;
}

function padCell(text: string, width: number): string {
	return truncateToWidth(text.padEnd(Math.max(0, width)), width);
}

function rightAligned(left: string, right: string, width: number): string {
	const gap = 1;
	const maxLeft = Math.max(1, width - right.length - gap);
	const clipped = truncateToWidth(left, maxLeft);
	const pad = Math.max(0, width - clipped.length - right.length);
	return clipped + " ".repeat(pad) + right;
}

function detailLines(item: RosterItem | undefined, theme: Theme): string[] {
	if (!item) return [theme.fg("dim", "No agents — spawn with subagent / subagent_spawn")];
	if (item.kind === "foreground") {
		const r = item.run;
		const lines = [
			theme.bold(`Foreground ${r.mode}`),
			withIcon(colorStatus(theme, r.state, statusGlyph(r.state)), `${r.state}`),
			theme.fg("muted", `Label: ${r.label}`),
			theme.fg("muted", `Agents: ${r.agentNames.join(", ") || "—"}`),
			theme.fg("dim", `id ${shortId(r.id)}`),
		];
		if (r.summary) lines.push(theme.fg("toolOutput", r.summary));
		return lines;
	}
	const a = item.agent;
	const lines = [
		theme.bold(`${a.agent} · ${shortId(a.id)}`),
		withIcon(colorStatus(theme, a.state, statusGlyph(a.state)), a.state),
		theme.fg("muted", `cwd: ${a.cwd}`),
	];
	if (a.model) lines.push(theme.fg("dim", `model: ${a.model}`));
	if (a.currentTask) {
		lines.push(theme.fg("muted", "─── Task ───"));
		lines.push(...wrapTextWithAnsi(theme.fg("text", a.currentTask), 72));
	}
	if (a.error) lines.push(theme.fg("error", withIcon(ICONS.fail, a.error)));
	const last = a.history[a.history.length - 1];
	if (last?.output) {
		lines.push(theme.fg("muted", "─── Last output ───"));
		const preview = last.output.trim().split("\n").slice(0, 24);
		for (const line of preview) lines.push(theme.fg("toolOutput", line));
		if (last.output.trim().split("\n").length > 24) {
			lines.push(theme.fg("dim", "…"));
		}
	}
	if (a.children.length > 0) {
		lines.push(theme.fg("muted", `children: ${a.children.map(shortId).join(", ")}`));
	}
	return lines;
}

class AgentViewPanel implements Component {
	private tui: TUI;
	private theme: Theme;
	private done: (result: undefined) => void;
	private selected = 0;
	private detailScroll = 0;
	private detailAutoFollow = true;
	private detailLineCount = 0;
	private bodyHeight = 12;
	private tick = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;
	private disposed = false;
	private includeClosed = true;

	constructor(tui: TUI, theme: Theme, done: (result: undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.unsubscribe = subscribeAgentBridge(() => {
			if (this.disposed) return;
			this.tui.requestRender();
		});
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.tick++;
			this.tui.requestRender();
		}, 400);
		this.timer.unref?.();
	}

	private items(): RosterItem[] {
		return collectRoster().filter((item) => {
			if (this.includeClosed) return true;
			const st = itemState(item);
			return st === "running" || st === "starting" || st === "idle" || st === "completed";
		});
	}

	private moveSelection(delta: number): void {
		const items = this.items();
		if (items.length === 0) return;
		this.selected = Math.max(0, Math.min(items.length - 1, this.selected + delta));
		this.detailScroll = 0;
		this.detailAutoFollow = true;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data.toLowerCase() === "q") {
			this.dispose();
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || data.toLowerCase() === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "down") || data.toLowerCase() === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.moveSelection(-999);
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(999);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.detailAutoFollow = false;
			this.detailScroll = Math.max(0, this.detailScroll - this.bodyHeight);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			const maxScroll = Math.max(0, this.detailLineCount - this.bodyHeight);
			this.detailScroll = Math.min(maxScroll, this.detailScroll + this.bodyHeight);
			this.detailAutoFollow = this.detailScroll >= maxScroll;
			this.tui.requestRender();
			return;
		}
		if (data.toLowerCase() === "c") {
			this.includeClosed = !this.includeClosed;
			this.selected = 0;
			this.tui.requestRender();
		}
	}

	private rosterLines(width: number): string[] {
		const items = this.items();
		if (items.length === 0) return [this.theme.fg("dim", "No tracked agents")];
		const start = Math.max(
			0,
			Math.min(this.selected - this.bodyHeight + 1, Math.max(0, items.length - this.bodyHeight)),
		);
		return items.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const focused = index === this.selected;
			const marker = focused ? this.theme.fg("accent", "❯") : " ";
			const st = itemState(item);
			const live = st === "running" || st === "starting";
			const glyph = live
				? this.theme.fg("warning", spinFrame(this.tick))
				: colorStatus(this.theme, st, statusGlyph(st));
			const source = item.kind === "foreground" ? "live" : "det.";
			const left = `${marker} ${glyph} ${source} ${itemLabel(item)}`;
			return rightAligned(left, this.theme.fg("dim", st), width);
		});
	}

	render(width: number): string[] {
		if (width < 36) {
			return [truncateToWidth("Agent View needs at least 36 columns. Esc closes.", width)];
		}
		const theme = this.theme;
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		this.bodyHeight = Math.max(2, Math.min(30, Math.floor(rows * 0.85) - 6));
		const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.4)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const items = this.items();
		if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);
		const roster = this.rosterLines(rosterWidth);
		const selected = items[this.selected];
		const detailsRaw = detailLines(selected, theme);
		const details: string[] = [];
		for (const line of detailsRaw) {
			const wrapped = wrapTextWithAnsi(line, Math.max(1, detailWidth));
			details.push(...(wrapped.length ? wrapped : [""]));
		}
		this.detailLineCount = details.length;
		const maxDetailScroll = Math.max(0, details.length - this.bodyHeight);
		if (this.detailAutoFollow) this.detailScroll = maxDetailScroll;
		else if (this.detailScroll > maxDetailScroll) this.detailScroll = maxDetailScroll;
		const visibleDetails = details.slice(this.detailScroll, this.detailScroll + this.bodyHeight);

		const lines = [theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		const title = withIcon(
			theme.fg("accent", ICONS.active),
			theme.bold("Agent View") + theme.fg("dim", " · live subagents · /agents"),
		);
		lines.push(theme.fg("border", "│") + padCell(` ${title}`, innerWidth) + theme.fg("border", "│"));
		lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
		for (let i = 0; i < this.bodyHeight; i++) {
			lines.push(
				theme.fg("border", "│") +
					padCell(roster[i] ?? "", rosterWidth) +
					theme.fg("border", "│") +
					padCell(visibleDetails[i] ?? "", detailWidth) +
					theme.fg("border", "│"),
			);
		}
		lines.push(theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
		const position = items.length ? `${this.selected + 1}/${items.length}` : "0/0";
		const footer = ` ↑↓/jk · PgUp/PgDn · c closed · Esc · ${position}`;
		lines.push(theme.fg("border", "│") + padCell(theme.fg("dim", footer), innerWidth) + theme.fg("border", "│"));
		lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		/* roster is live */
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.unsubscribe?.();
	}
}

export async function openAgentView(ctx: { ui: Pick<ExtensionUIContext, "custom">; hasUI?: boolean }): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new AgentViewPanel(tui, theme, done), {
		overlay: true,
		overlayOptions: CENTER_OVERLAY,
	});
}
