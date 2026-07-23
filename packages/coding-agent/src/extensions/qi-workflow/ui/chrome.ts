/**
 * Shared overlay chrome — padding, box frames, padded rules.
 * Borders are always laid out with visibleWidth so ANSI / wide glyphs cannot
 * shift ╭─╮ / │ │ / ╰─╯ corners (the usual “broken border” failure mode).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

export const CHROME = {
	sidePad: 2,
	contentPad: 4,
	footerSep: " · ",
	focusPrefix: "> ",
	treeBranch: "├─",
	treeLast: "└─",
} as const;

export function sidePadStr(n: number = CHROME.sidePad): string {
	return " ".repeat(Math.max(0, n));
}

export function contentWidth(width: number, pad = CHROME.sidePad): number {
	return Math.max(1, width - pad * 2);
}

/**
 * Fit text into exactly `width` visible columns (truncate + pad).
 * Never use String#padEnd for panel cells — it counts code units, not columns.
 */
export function fitCell(text: string, width: number): string {
	const w = Math.max(0, width);
	if (w === 0) return "";
	const truncated = truncateToWidth(text, w, "…", true);
	const pad = Math.max(0, w - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

/** Left-pad a single line; truncate to outer width. */
export function padLine(_theme: Theme, text: string, width: number, pad = CHROME.sidePad): string {
	const gutter = sidePadStr(pad);
	return truncateToWidth(gutter + text, width);
}

/** Pad each wrapped body line with content gutter. */
export function indentLines(lines: string[], pad = CHROME.contentPad): string[] {
	const gutter = sidePadStr(pad);
	return lines.map((l) => gutter + l);
}

export function hintLine(theme: Theme, parts: string[], width: number, pad = CHROME.sidePad): string {
	const body = parts.filter(Boolean).join(CHROME.footerSep);
	return padLine(theme, theme.fg("dim", body), width, pad);
}

export function mutedRule(theme: Theme, width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

export interface BoxPanelOptions {
	title: string;
	width: number;
	/** Body lines already without box borders (raw content). */
	body: string[];
	/** Optional footer / hint lines (raw). */
	footer?: string[];
	/**
	 * Hard cap on total output lines (incl. borders). Body is truncated with
	 * an ellipsis row so the bottom ╰─╯ is never clipped by TUI maxHeight.
	 */
	maxHeight?: number;
	/**
	 * When set with maxHeight, pad empty body rows so the panel paints the full
	 * height (fullscreen sheets — no see-through void).
	 */
	fillHeight?: boolean;
}

export interface SplitBoxPanelOptions {
	title: string;
	width: number;
	/** Left column width (visible columns inside the box, excluding the mid │). */
	leftWidth: number;
	left: string[];
	right: string[];
	footer?: string;
	/** Fixed body row count (pads/truncates both columns). */
	bodyRows: number;
}

function boxBorder(theme: Theme, text: string): string {
	return theme.fg("border", text);
}

function clampBody(body: string[], maxBody: number): string[] {
	if (body.length <= maxBody) return body;
	if (maxBody <= 0) return [];
	if (maxBody === 1) return ["…"];
	return [...body.slice(0, maxBody - 1), "…"];
}

/**
 * Draw a centered title box: ╭─ Title ─╮ / │ body │ / ╰───╯
 * Body and footer are padded with one space inside the borders.
 */
export function renderBoxPanel(theme: Theme, opts: BoxPanelOptions): string[] {
	const w = Math.max(8, opts.width);
	const innerW = w - 2;
	const border = (s: string) => boxBorder(theme, s);
	const titleFg = (s: string) => theme.fg("accent", s);

	const row = (content: string): string => {
		return border("│") + fitCell(` ${content}`, innerW) + border("│");
	};

	const emptyRow = (): string => border("│") + " ".repeat(innerW) + border("│");
	const divider = (): string => border(`├${"─".repeat(innerW)}┤`);

	// title + leading empty + bottom border (+ footer chrome if present)
	const footer = opts.footer ?? [];
	const chrome =
		2 /* title + leading empty */ +
		1 /* bottom */ +
		(footer.length > 0 ? 3 /* empty+div+empty */ + footer.length : 0);
	const maxBody = opts.maxHeight !== undefined ? Math.max(1, opts.maxHeight - chrome) : Number.POSITIVE_INFINITY;
	let body = clampBody(opts.body, maxBody);
	if (opts.fillHeight && opts.maxHeight !== undefined && Number.isFinite(maxBody)) {
		while (body.length < maxBody) body = [...body, ""];
	}

	const titleText = ` ${opts.title.trim()} `;
	const borderLen = Math.max(0, innerW - visibleWidth(titleText));
	const leftB = Math.floor(borderLen / 2);
	const rightB = borderLen - leftB;
	const lines: string[] = [
		border(`╭${"─".repeat(leftB)}`) + titleFg(titleText) + border(`${"─".repeat(rightB)}╮`),
		emptyRow(),
	];

	if (body.length === 0) {
		lines.push(emptyRow());
	} else {
		for (const line of body) {
			lines.push(line === "" ? emptyRow() : row(line));
		}
	}

	if (footer.length > 0) {
		lines.push(emptyRow());
		lines.push(divider());
		lines.push(emptyRow());
		for (const line of footer) {
			lines.push(row(line));
		}
	}

	lines.push(border(`╰${"─".repeat(innerW)}╯`));
	return lines;
}

/**
 * Two-column box used by Agent View. Column widths always sum to inner width
 * so ┬/┴ junctions stay aligned with the mid │ on every row.
 */
export function renderSplitBoxPanel(theme: Theme, opts: SplitBoxPanelOptions): string[] {
	const w = Math.max(16, opts.width);
	const innerW = w - 2;
	const leftW = Math.max(4, Math.min(opts.leftWidth, innerW - 6));
	const rightW = Math.max(4, innerW - leftW - 1);
	const border = (s: string) => boxBorder(theme, s);
	const titleFg = (s: string) => theme.fg("accent", s);

	const titleText = ` ${opts.title.trim()} `;
	const borderLen = Math.max(0, innerW - visibleWidth(titleText));
	const leftB = Math.floor(borderLen / 2);
	const rightB = borderLen - leftB;

	const lines: string[] = [
		border(`╭${"─".repeat(leftB)}`) + titleFg(titleText) + border(`${"─".repeat(rightB)}╮`),
		border(`├${"─".repeat(leftW)}┬${"─".repeat(rightW)}┤`),
	];

	for (let i = 0; i < opts.bodyRows; i++) {
		lines.push(
			border("│") +
				fitCell(opts.left[i] ?? "", leftW) +
				border("│") +
				fitCell(opts.right[i] ?? "", rightW) +
				border("│"),
		);
	}

	lines.push(border(`├${"─".repeat(leftW)}┴${"─".repeat(rightW)}┤`));
	if (opts.footer) {
		lines.push(border("│") + fitCell(theme.fg("dim", ` ${opts.footer}`), innerW) + border("│"));
	}
	lines.push(border(`╰${"─".repeat(innerW)}╯`));
	return lines;
}

/** Bottom-overlay banner stripe (rpiv-btw / custom message style). */
export function renderBanner(theme: Theme, label: string, detail: string, width: number): string {
	const pad = sidePadStr();
	const prefix = `${pad}${label} `;
	const avail = Math.max(0, width - visibleWidth(prefix));
	const q = truncateToWidth(detail.replace(/\s+/g, " ").trim(), avail, "…", false);
	return theme.bg("customMessageBg", theme.fg("customMessageText", fitCell(prefix + q, width)));
}
