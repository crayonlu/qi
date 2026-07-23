/**
 * Shared overlay chrome — padding, box frames, padded rules.
 * Mirrors pi-mcp-adapter boxed panels + rpiv-btw gutters (no emoji).
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
}

/**
 * Draw a centered title box: ╭─ Title ─╮ / │ body │ / ╰───╯
 * Body and footer are padded with one space inside the borders.
 */
export function renderBoxPanel(theme: Theme, opts: BoxPanelOptions): string[] {
	const w = Math.max(8, opts.width);
	const innerW = w - 2;
	const border = (s: string) => theme.fg("border", s);
	const titleFg = (s: string) => theme.fg("accent", s);

	const row = (content: string): string => {
		const padded = truncateToWidth(` ${content}`, innerW, "…", true);
		const fill = " ".repeat(Math.max(0, innerW - visibleWidth(padded)));
		return border("│") + padded + fill + border("│");
	};

	const emptyRow = (): string => border("│") + " ".repeat(innerW) + border("│");
	const divider = (): string => border("├" + "─".repeat(innerW) + "┤");

	const titleText = ` ${opts.title.trim()} `;
	const borderLen = Math.max(0, innerW - visibleWidth(titleText));
	const leftB = Math.floor(borderLen / 2);
	const rightB = borderLen - leftB;
	const lines: string[] = [
		border("╭" + "─".repeat(leftB)) + titleFg(titleText) + border("─".repeat(rightB) + "╮"),
		emptyRow(),
	];

	if (opts.body.length === 0) {
		lines.push(emptyRow());
	} else {
		for (const line of opts.body) {
			lines.push(row(line));
		}
	}

	if (opts.footer && opts.footer.length > 0) {
		lines.push(emptyRow());
		lines.push(divider());
		lines.push(emptyRow());
		for (const line of opts.footer) {
			lines.push(row(line));
		}
	}

	lines.push(border("╰" + "─".repeat(innerW) + "╯"));
	return lines;
}

/** Bottom-overlay banner stripe (rpiv-btw / custom message style). */
export function renderBanner(theme: Theme, label: string, detail: string, width: number): string {
	const pad = sidePadStr();
	const prefix = `${pad}${label} `;
	const avail = Math.max(0, width - visibleWidth(prefix));
	const q = truncateToWidth(detail.replace(/\s+/g, " ").trim(), avail, "…", false);
	const raw = prefix + q;
	const padded = raw + " ".repeat(Math.max(0, width - visibleWidth(raw)));
	return theme.bg("customMessageBg", theme.fg("customMessageText", padded));
}
