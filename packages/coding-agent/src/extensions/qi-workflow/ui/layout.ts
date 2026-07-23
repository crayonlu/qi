/**
 * Qi panel surfaces — single place for overlay geometry and input-chrome rules.
 *
 * Architecture:
 * - Overlays are terminal-absolute. Without a reserved bottom inset they paint
 *   over the editor/footer (Agent View / center modals) or float away from a
 *   top-aligned short session (empty /btw).
 * - Every Qi overlay MUST leave `INPUT_CHROME_ROWS` free at the bottom.
 * - `sheet` = full-width bottom strip (btw / ask / mcp / agent view).
 * - `modal` = centered dialog that still clears the input chrome (dashboard…).
 * - Borders must be laid out with visibleWidth (see chrome.fitCell), never
 *   String#padEnd / raw length — ANSI and wide glyphs otherwise shift │ corners.
 */

import type { OverlayOptions } from "@earendil-works/pi-tui";

/** Editor (~2) + footer status (~1) + 1 breath row. Reserved under every overlay. */
export const INPUT_CHROME_ROWS = 4;

/** @deprecated use INPUT_CHROME_ROWS */
export const BOTTOM_INPUT_GAP = INPUT_CHROME_ROWS;

export type PanelSurface = "sheet" | "modal";

const SHEET: OverlayOptions = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: "50%",
	margin: { left: 0, right: 0, bottom: INPUT_CHROME_ROWS },
};

const MODAL: OverlayOptions = {
	anchor: "center",
	width: "95%",
	minWidth: 60,
	maxHeight: "70%",
	margin: { top: 1, right: 1, bottom: INPUT_CHROME_ROWS, left: 1 },
};

/** Overlay options for a panel surface. Always clears the input chrome. */
export function panelOverlay(surface: PanelSurface): OverlayOptions {
	return surface === "sheet" ? { ...SHEET } : { ...MODAL };
}

/** Ask / /btw / MCP / Agent View — bottom sheet above the input. */
export const BOTTOM_OVERLAY: OverlayOptions = panelOverlay("sheet");

/** Dashboard / rewind / cleanup — centered modal that still clears the input. */
export const CENTER_OVERLAY: OverlayOptions = panelOverlay("modal");

/**
 * Max total lines an overlay may emit for a surface (matches TUI maxHeight
 * after input-chrome margin). Panels must stay within this or TUI will
 * slice the bottom border off.
 */
export function panelMaxHeight(rows: number, surface: PanelSurface): number {
	const pct = surface === "sheet" ? 0.5 : 0.7;
	const marginBottom = INPUT_CHROME_ROWS;
	const marginTop = surface === "modal" ? 1 : 0;
	const avail = Math.max(4, rows - marginTop - marginBottom);
	return Math.max(6, Math.min(Math.floor(rows * pct), avail));
}

/**
 * Max body rows inside a boxed panel so title/footer/borders still fit.
 */
export function panelMaxBodyRows(rows: number, surface: PanelSurface, chromeRows = 6): number {
	return Math.max(2, panelMaxHeight(rows, surface) - chromeRows);
}

export function termCols(): number {
	return process.stdout.columns ?? 80;
}

export function termRows(): number {
	return process.stdout.rows ?? 24;
}

/** Prefer the TUI's terminal size when available (tests / alternate ttys). */
export function tuiRows(tui: { terminal?: { rows?: number } } | null | undefined): number {
	return tui?.terminal?.rows ?? termRows();
}
