import type { Component, TUI } from "@earendil-works/pi-tui";
import { Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { getMarkdownTheme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import { type BtwDraft, clearBtw } from "../domain/index.ts";
import { clearBtwHistory } from "../runtime/btw-side-turn.ts";
import { hintLine, renderBanner, sidePadStr } from "./chrome.ts";
import { BOTTOM_OVERLAY, panelMaxHeight, tuiRows } from "./layout.ts";

type BtwCloseResult = { attachSummary?: string };

const SIDE_PAD = sidePadStr(2);
const ANSWER_PAD = sidePadStr(4);
const BTW_LITERAL = "/btw";

class BtwOverlay implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private done: (result: BtwCloseResult) => void;
	private sessionCtx?: ExtensionContext;
	private onAbort?: () => void;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private unsubscribe: (() => void) | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		controller: WorkflowController,
		done: (result: BtwCloseResult) => void,
		sessionCtx?: ExtensionContext,
		onAbort?: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.done = done;
		this.sessionCtx = sessionCtx;
		this.onAbort = onAbort;
		this.unsubscribe = controller.subscribe(() => {
			this.invalidate();
			this.tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe?.();
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
			const btw = this.draft();
			if (btw && !btw.answer && this.onAbort) {
				this.onAbort();
				this.done({});
				return;
			}
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
			this.scrollOffset = 0;
			this.refresh();
			return;
		}
		if (data === "a" || data === "A") {
			const btw = this.draft();
			if (!btw?.answer) {
				return;
			}
			const summary = [`[btw] ${btw.question}`, btw.answer].join("\n");
			this.controller.apply((state) => clearBtw(state));
			this.done({ attachSummary: summary });
		}
	}

	private historyLine(question: string, width: number): string {
		const qAvail = Math.max(0, width - SIDE_PAD.length);
		const qClean = question.replace(/\s+/g, " ").trim();
		const raw = `${BTW_LITERAL} ${qClean}`;
		return SIDE_PAD + this.theme.fg("muted", truncateToWidth(raw, qAvail, "…", false));
	}

	private renderMarkdownAnswer(text: string, width: number): string[] {
		const bodyWidth = Math.max(1, width - ANSWER_PAD.length);
		const md = new Markdown(text, 0, 0, getMarkdownTheme());
		return md.render(bodyWidth).map((l) => ANSWER_PAD + l);
	}

	private renderPlainAnswer(text: string, width: number, color: "text" | "error" | "warning"): string[] {
		const bodyWidth = Math.max(1, width - ANSWER_PAD.length);
		const out: string[] = [];
		for (const ln of text.split("\n")) {
			const src = ln.length === 0 ? " " : ln;
			out.push(...wrapTextWithAnsi(this.theme.fg(color, src), bodyWidth).map((l) => ANSWER_PAD + l));
		}
		return out;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const w = Math.max(1, width);
		const btw = this.draft();
		const maxRows = panelMaxHeight(tuiRows(this.tui), "sheet");

		const header: string[] = [];
		const body: string[] = [];
		const footer: string[] = [];

		if (!btw) {
			header.push(renderBanner(th, BTW_LITERAL, "(idle)", w), "");
			body.push(SIDE_PAD + th.fg("dim", "No active /btw draft"));
			footer.push("", hintLine(th, ["Esc close"], w));
		} else {
			// Banner holds the question once — do not also echo `/btw …` (was the dup).
			header.push(renderBanner(th, BTW_LITERAL, btw.question, w), "");

			const priorQs = btw.history
				.filter((t) => t.role === "user")
				.map((t) => t.text)
				.filter((q) => q.trim() !== btw.question.trim());
			for (const q of priorQs) {
				header.push(this.historyLine(q, w));
			}
			if (priorQs.length > 0) header.push("");

			if (btw.answer) {
				body.push(...this.renderMarkdownAnswer(btw.answer, w));
			} else if (btw.error) {
				body.push(...this.renderPlainAnswer(btw.error, w, "error"));
			} else {
				body.push(ANSWER_PAD + th.fg("warning", "…"));
			}

			const hints: string[] = [];
			if (btw.answer || btw.error) hints.push("↑↓ scroll");
			if (priorQs.length > 0) hints.push("x clear");
			if (btw.answer) hints.push("a attach");
			hints.push(btw.answer || btw.error ? "Esc close" : "Esc abort");
			footer.push("", hintLine(th, hints, w));
		}

		const used = header.length + body.length + footer.length;
		const pad = Math.max(0, maxRows - used);
		const natural = [...header, ...body, ...Array.from({ length: pad }, () => ""), ...footer];

		let view = natural;
		if (natural.length > maxRows) {
			const excess = natural.length - maxRows;
			if (this.scrollOffset > excess) this.scrollOffset = excess;
			const start = excess - this.scrollOffset;
			view = natural.slice(start, start + maxRows);
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
 * When `onAbort` is set, Esc during a pending answer aborts the in-flight side turn.
 */
export async function showBtwOverlay(
	ctx: { ui: ExtensionUIContext } & Partial<ExtensionContext>,
	controller: WorkflowController,
	opts?: { onAbort?: () => void },
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
	if (state.btw.hiddenByQuestion) {
		return;
	}

	const sessionCtx = "sessionManager" in ctx && ctx.sessionManager ? (ctx as ExtensionContext) : undefined;

	const result = await ctx.ui.custom<BtwCloseResult>(
		(tui, theme, _kb, done) => new BtwOverlay(tui, theme, controller, done, sessionCtx, opts?.onAbort),
		{ overlay: true, overlayOptions: BOTTOM_OVERLAY },
	);

	if (result?.attachSummary) {
		ctx.ui.pasteToEditor(result.attachSummary);
		ctx.ui.notify("Attached /btw summary to editor", "info");
	}
}
