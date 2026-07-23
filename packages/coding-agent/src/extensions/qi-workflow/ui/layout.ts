/**
 * Shared overlay geometry for Qi center panels and bottom overlays.
 * Surfaces keep their own chrome (hints, preview, filters) — only frame is shared.
 *
 * Gap rule: bottom sheets sit just above the editor/footer (small margin.bottom).
 * Never use center anchoring for input-adjacent surfaces — empty sessions otherwise
 * leave a ~half-screen void between the panel and the editor.
 */

/** Rows reserved under bottom sheets for editor + footer status. */
export const BOTTOM_INPUT_GAP = 3;

export const CENTER_OVERLAY = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 60,
	maxHeight: "85%" as const,
	margin: 1,
};

/** Ask / /btw / MCP — full-width bottom sheet, flush above the input. */
export const BOTTOM_OVERLAY = {
	anchor: "bottom-center" as const,
	width: "100%" as const,
	maxHeight: "50%" as const,
	margin: { left: 0, right: 0, bottom: BOTTOM_INPUT_GAP },
};

export function termCols(): number {
	return process.stdout.columns ?? 80;
}
