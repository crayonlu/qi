import type { Theme, ThemeColor } from "../../../modes/interactive/theme/theme.ts";

/** Any workflow-ish status string mapped to a Pi theme semantic token. */
export type StatusLike = string;

/**
 * Map entity status → Pi ThemeColor token.
 * running → accent, waiting → muted, completed → success,
 * failed → error, cancelled → warning, stale/unknown → dim.
 */
export function statusThemeColor(status: StatusLike): ThemeColor {
	switch (status) {
		case "running":
		case "executing":
		case "connecting":
		case "terminating":
			return "thinkingText";
		case "active":
			return "accent";
		case "in_progress":
			// Active work attention (rpiv-todo uses warning for ◐)
			return "warning";
		case "waiting":
		case "pending":
		case "draft":
		case "disconnected":
		case "paused":
			return "muted";
		case "completed":
		case "ready":
		case "answered":
		case "connected":
		case "exited":
			return "success";
		case "failed":
		case "error":
		case "killed":
		case "blocked":
			return "error";
		case "cancelled":
		case "discarded":
		case "disabled":
			return "warning";
		default:
			return "dim";
	}
}

/** Colorize a status label with the matching semantic token. */
export function colorStatus(theme: Theme, status: StatusLike, text?: string): string {
	return theme.fg(statusThemeColor(status), text ?? status);
}
