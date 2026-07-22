import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import { type BtwDraft, clearBtw } from "../domain/index.ts";
import { clearBtwHistory } from "../runtime/btw-side-turn.ts";

const OVERLAY_OPTIONS = {
	anchor: "bottom-center" as const,
	width: "100%" as const,
	maxHeight: "80%" as const,
	margin: { left: 0, right: 0, bottom: 0 },
};

type BtwCloseResult = { attachSummary?: string };

class BtwOverlay implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private done: (result: BtwCloseResult) => void;
	private sessionCtx?: ExtensionContext;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tui: TUI,
		theme: Theme,
		controller: WorkflowController,
		done: (result: BtwCloseResult) => void,
		sessionCtx?: ExtensionContext,
	) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.done = done;
		this.sessionCtx = sessionCtx;
	}

	private draft(): BtwDraft | null {
		return this.controller.getState().btw;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({});
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset += 1;
			this.refresh();
			return;
		}
		if (data === "x" || data === "X") {
			if (this.sessionCtx) {
				clearBtwHistory(this.sessionCtx);
			} else {
				this.controller.apply((state) => clearBtw(state));
			}
			this.done({});
			return;
		}
		if (data === "a" || data === "A") {
			const btw = this.draft();
			if (!btw) {
				this.done({});
				return;
			}
			const summary = [`[btw] ${btw.question}`, btw.answer ?? "(no answer yet)"].join("\n");
			this.controller.apply((state) => clearBtw(state));
			this.done({ attachSummary: summary });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const w = Math.max(1, width);
		const btw = this.draft();
		const lines: string[] = [];

		lines.push(th.fg("accent", "─".repeat(w)));
		lines.push(truncateToWidth(th.fg("accent", "/btw"), w));

		if (!btw) {
			lines.push(truncateToWidth(th.fg("dim", "No active /btw draft"), w));
		} else {
			lines.push(...wrapTextWithAnsi(th.fg("muted", btw.question), w));
			lines.push("");

			for (const turn of btw.history) {
				const prefix = turn.role === "user" ? th.fg("accent", "you ") : th.fg("muted", "btw ");
				lines.push(...wrapTextWithAnsi(prefix + th.fg("text", turn.text), w));
			}

			if (btw.answer) {
				lines.push("");
				lines.push(...wrapTextWithAnsi(th.fg("text", btw.answer), w));
			} else {
				lines.push("");
				lines.push(truncateToWidth(th.fg("dim", "… waiting for answer"), w));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(th.fg("dim", "↑↓ scroll · a attach summary · x clear · Esc close"), w));
		lines.push(th.fg("accent", "─".repeat(w)));

		const rows = (this.tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? 24;
		const maxRows = Math.max(4, Math.floor(rows * 0.8));
		let view = lines;
		if (lines.length > maxRows) {
			const excess = lines.length - maxRows;
			if (this.scrollOffset > excess) this.scrollOffset = excess;
			const start = excess - this.scrollOffset;
			view = lines.slice(start, start + maxRows);
		}

		this.cachedWidth = width;
		this.cachedLines = view;
		return view;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * Show /btw overlay. If a structured question is open, does not show (question priority).
 * Draft is preserved when hiddenByQuestion — caller should re-open after question closes.
 */
export async function showBtwOverlay(
	ctx: { ui: ExtensionUIContext } & Partial<ExtensionContext>,
	controller: WorkflowController,
): Promise<void> {
	const state = controller.getState();
	if (state.question?.status === "open") {
		ctx.ui.notify("Structured question has priority over /btw", "warning");
		return;
	}
	if (!state.btw) {
		ctx.ui.notify("No active /btw draft", "info");
		return;
	}
	// Preserve draft while hiddenByQuestion — just don't show.
	if (state.btw.hiddenByQuestion) {
		return;
	}

	const sessionCtx = "sessionManager" in ctx && ctx.sessionManager ? (ctx as ExtensionContext) : undefined;

	const result = await ctx.ui.custom<BtwCloseResult>(
		(tui, theme, _kb, done) => new BtwOverlay(tui, theme, controller, done, sessionCtx),
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);

	if (result?.attachSummary) {
		ctx.ui.pasteToEditor(result.attachSummary);
		ctx.ui.notify("Attached /btw summary to editor", "info");
	}
}
