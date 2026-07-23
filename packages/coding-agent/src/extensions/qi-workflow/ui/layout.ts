/**
 * Shared overlay geometry for Qi center panels and bottom overlays.
 * Surfaces keep their own chrome (hints, preview, filters) — only frame is shared.
 */

export const CENTER_OVERLAY = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 60,
	maxHeight: "85%" as const,
	margin: 1,
};

/** Ask / /btw — full-width bottom strip with bounded height. */
export const BOTTOM_OVERLAY = {
	anchor: "bottom-center" as const,
	width: "100%" as const,
	maxHeight: "80%" as const,
	margin: { left: 0, right: 0, bottom: 0 },
};

export function termCols(): number {
	return process.stdout.columns ?? 80;
}
