/**
 * Qi panel surfaces — overlay geometry for sheets vs modals.
 *
 * Architecture:
 * - `sheet` (btw / ask / mcp) = true fullscreen covering the input. Esc dismisses.
 *   Content fills the viewport top→bottom; no half-height float, no top void.
 * - `modal` (dashboard / rewind / cleanup / agent view) = centered dialog that
 *   still clears `INPUT_CHROME_ROWS` so the editor stays usable underneath.
 * - Borders must use visibleWidth (see chrome.fitCell), never String#padEnd.
 */

import type { OverlayOptions } from "@earendil-works/pi-tui";

/** Editor (~2) + footer status (~1) + 1 breath row. Reserved under modals only. */
export const INPUT_CHROME_ROWS = 4;

/** @deprecated use INPUT_CHROME_ROWS */
export const BOTTOM_INPUT_GAP = INPUT_CHROME_ROWS;

export type PanelSurface = "sheet" | "modal";

/** Fullscreen sheet: covers input; panels must paint enough rows to fill. */
const SHEET: OverlayOptions = {
	anchor: "top-center",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
};

const MODAL: OverlayOptions = {
	anchor: "center",
	width: "95%",
	minWidth: 60,
	maxHeight: "70%",
	margin: { top: 1, right: 1, bottom: INPUT_CHROME_ROWS, left: 1 },
};

/** Overlay options for a panel surface. */
export function panelOverlay(surface: PanelSurface): OverlayOptions {
	return surface === "sheet" ? { ...SHEET } : { ...MODAL };
}

/** Ask / /btw / MCP — fullscreen sheet covering the input. */
export const BOTTOM_OVERLAY: OverlayOptions = panelOverlay("sheet");

/** Dashboard / rewind / cleanup / Agent View — centered modal clearing input chrome. */
export const CENTER_OVERLAY: OverlayOptions = panelOverlay("modal");

/**
 * Max total lines an overlay may emit for a surface (matches TUI maxHeight
 * after margins). Sheets fill the terminal; modals stay under input chrome.
 */
export function panelMaxHeight(rows: number, surface: PanelSurface): number {
	if (surface === "sheet") {
		return Math.max(6, rows);
	}
	const marginBottom = INPUT_CHROME_ROWS;
	const marginTop = 1;
	const avail = Math.max(4, rows - marginTop - marginBottom);
	return Math.max(6, Math.min(Math.floor(rows * 0.7), avail));
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
