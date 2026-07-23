/**
 * Structured ask overlay — Qi unified bottom-center style.
 * Shows option preview, optional notes (n), and multi-question progress.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import { answerQuestion, cancelQuestion, type StructuredQuestion } from "../domain/index.ts";
import { renderBanner } from "./chrome.ts";
import { BOTTOM_OVERLAY, panelMaxHeight, tuiRows } from "./layout.ts";

export type QuestionOverlayResult =
	| { action: "answered"; selected: string[]; freeInput?: string; notes?: string; answerSummary: string }
	| { action: "cancelled" };

class QuestionOverlay implements Component {
	private tui: TUI;
	private theme: Theme;
	private question: StructuredQuestion;
	private allowFreeInput: boolean;
	private done: (result: QuestionOverlayResult) => void;
	private controller: WorkflowController;
	private optionIndex = 0;
	private selected = new Set<number>();
	private freeMode = false;
	private notesMode = false;
	private freeText = "";
	private notesText = "";
	private collapsed = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tui: TUI,
		theme: Theme,
		question: StructuredQuestion,
		controller: WorkflowController,
		done: (result: QuestionOverlayResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.question = question;
		this.allowFreeInput = question.allowFreeInput !== false;
		this.controller = controller;
		this.done = done;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private submit(selected: string[], freeInput?: string): void {
		const notes = this.notesText.trim() || undefined;
		const result = this.controller.apply((state) => answerQuestion(state, selected, freeInput, notes));
		if (!result.ok) {
			this.done({ action: "cancelled" });
			return;
		}
		this.done({
			action: "answered",
			selected,
			freeInput: freeInput?.trim() || undefined,
			notes,
			answerSummary: result.value.answerSummary ?? selected.join("; "),
		});
	}

	private cancel(): void {
		this.controller.apply((state) => cancelQuestion(state));
		this.done({ action: "cancelled" });
	}

	private handleTextMode(data: string, mode: "free" | "notes", onDone: (text: string) => void): boolean {
		if (matchesKey(data, "escape")) {
			if (mode === "free") {
				this.freeMode = false;
				this.freeText = "";
			} else {
				this.notesMode = false;
			}
			this.refresh();
			return true;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			onDone(mode === "free" ? this.freeText : this.notesText);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			if (mode === "free") this.freeText = this.freeText.slice(0, -1);
			else this.notesText = this.notesText.slice(0, -1);
			this.refresh();
			return true;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			if (mode === "free") this.freeText += data;
			else this.notesText += data;
			this.refresh();
			return true;
		}
		return true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.cancel();
			return;
		}

		if (this.collapsed) {
			if (matchesKey(data, "escape") || data === "c" || data === "C") {
				this.collapsed = false;
				this.refresh();
			}
			return;
		}

		if (this.freeMode) {
			this.handleTextMode(data, "free", (text) => {
				const trimmed = text.trim();
				if (!trimmed) return;
				this.submit([], trimmed);
			});
			return;
		}

		if (this.notesMode) {
			this.handleTextMode(data, "notes", () => {
				this.notesMode = false;
				this.refresh();
			});
			return;
		}

		if (matchesKey(data, "escape")) {
			this.cancel();
			return;
		}
		if (data === "c" || data === "C") {
			this.collapsed = true;
			this.refresh();
			return;
		}
		if (data === "n" || data === "N") {
			this.notesMode = true;
			this.refresh();
			return;
		}
		if (matchesKey(data, "up")) {
			this.optionIndex = Math.max(0, this.optionIndex - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			const last = this.allowFreeInput ? this.question.options.length : this.question.options.length - 1;
			this.optionIndex = Math.min(last, this.optionIndex + 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "space") && this.question.multiSelect) {
			if (this.optionIndex < this.question.options.length) {
				if (this.selected.has(this.optionIndex)) this.selected.delete(this.optionIndex);
				else this.selected.add(this.optionIndex);
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.allowFreeInput && this.optionIndex === this.question.options.length) {
				this.freeMode = true;
				this.refresh();
				return;
			}
			if (this.question.multiSelect) {
				const labels = [...this.selected]
					.sort((a, b) => a - b)
					.map((i) => this.question.options[i]?.label)
					.filter((x): x is string => !!x);
				if (labels.length === 0 && this.optionIndex < this.question.options.length) {
					const label = this.question.options[this.optionIndex]?.label;
					if (label) labels.push(label);
				}
				if (labels.length === 0) return;
				this.submit(labels);
				return;
			}
			const opt = this.question.options[this.optionIndex];
			if (!opt) return;
			this.submit([opt.label]);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const w = Math.max(1, width);
		const progress =
			this.question.questionCount && this.question.questionCount > 1 && this.question.questionIndex
				? ` (${this.question.questionIndex}/${this.question.questionCount})`
				: "";

		if (this.collapsed) {
			const header = this.question.header ?? "Question";
			const line =
				th.fg("accent", `▸ Q${progress} `) +
				th.fg("text", truncateToWidth(header, Math.max(1, w - 20))) +
				th.fg("dim", "  [c expand · Esc cancel]");
			this.cachedWidth = width;
			this.cachedLines = [truncateToWidth(line, w)];
			return this.cachedLines;
		}

		const lines: string[] = [];
		const pad = "  ";
		lines.push(renderBanner(th, "Ask", `${this.question.header ?? "Question"}${progress}`, w));
		lines.push("");
		lines.push(...wrapTextWithAnsi(th.fg("text", this.question.prompt), Math.max(1, w - 4)).map((l) => pad + l));
		lines.push("");

		for (let i = 0; i < this.question.options.length; i++) {
			const opt = this.question.options[i]!;
			const focused = i === this.optionIndex && !this.freeMode && !this.notesMode;
			const checked = this.selected.has(i);
			const marker = this.question.multiSelect ? (checked ? "[x]" : "[ ]") : `${i + 1}.`;
			const prefix = focused ? th.fg("accent", "▸ ") : "  ";
			const label = th.fg(focused ? "accent" : "text", `${marker} ${opt.label}`);
			lines.push(truncateToWidth(pad + prefix + label, w));
			if (opt.description) {
				lines.push(truncateToWidth(`${pad}     ${th.fg("muted", opt.description)}`, w));
			}
			if (focused && opt.preview) {
				for (const previewLine of wrapTextWithAnsi(th.fg("dim", `     ▸ ${opt.preview}`), Math.max(1, w - 4))
					.slice(0, 6)
					.map((l) => pad + l)) {
					lines.push(previewLine);
				}
			}
		}

		if (this.allowFreeInput) {
			const freeIdx = this.question.options.length;
			const focused = this.optionIndex === freeIdx || this.freeMode;
			const prefix = focused ? th.fg("accent", "▸ ") : "  ";
			const label = th.fg(focused ? "accent" : "text", `${freeIdx + 1}. Type something…`);
			lines.push(truncateToWidth(pad + prefix + label, w));
			if (this.freeMode) {
				const cursor = th.fg("accent", "▌");
				const shown = this.freeText.length === 0 ? th.fg("dim", "…") : th.fg("text", this.freeText);
				lines.push(truncateToWidth(`${pad}  ${th.fg("muted", "answer:")} ${shown}${cursor}`, w));
			}
		}

		if (this.notesMode || this.notesText) {
			lines.push("");
			const cursor = this.notesMode ? th.fg("accent", "▌") : "";
			const shown = this.notesText.length === 0 ? th.fg("dim", "(optional notes)") : th.fg("text", this.notesText);
			lines.push(truncateToWidth(`${pad}  ${th.fg("muted", "notes:")} ${shown}${cursor}`, w));
		}

		lines.push("");
		const hint = this.freeMode
			? "Enter submit · Esc back"
			: this.notesMode
				? "Enter keep notes · Esc cancel notes edit"
				: this.question.multiSelect
					? "↑↓ · Space toggle · Enter submit · n notes · c collapse · Esc cancel"
					: "↑↓ · Enter select · n notes · c collapse · Esc cancel";
		lines.push(truncateToWidth(pad + th.fg("dim", hint), w));

		const maxRows = panelMaxHeight(tuiRows(this.tui), "sheet");
		let view = lines;
		if (lines.length > maxRows) {
			// Keep header + hint frame; scroll options region by focusing near optionIndex.
			const head = 3;
			const tail = 2;
			const body = lines.slice(head, Math.max(head, lines.length - tail));
			const focusApprox = Math.min(body.length - 1, Math.max(0, this.optionIndex + 1));
			const bodyBudget = Math.max(1, maxRows - head - tail);
			const start = Math.max(0, Math.min(focusApprox - Math.floor(bodyBudget / 2), body.length - bodyBudget));
			view = [
				...lines.slice(0, head),
				...body.slice(start, start + bodyBudget),
				...lines.slice(lines.length - tail),
			];
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
 * Show structured question overlay (bottom-center, full width, maxHeight 80%).
 */
export async function showQuestionOverlay(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
): Promise<QuestionOverlayResult> {
	const state = controller.getState();
	const question = state.question;
	if (!question || question.status !== "open") {
		return { action: "cancelled" };
	}

	return ctx.ui.custom<QuestionOverlayResult>(
		(tui, theme, _kb, done) => new QuestionOverlay(tui, theme, question, controller, done),
		{ overlay: true, overlayOptions: BOTTOM_OVERLAY },
	);
}
