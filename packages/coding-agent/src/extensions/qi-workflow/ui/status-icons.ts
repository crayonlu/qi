/**
 * Qi status icons — rpiv-todo geometric circle family.
 *
 * Vocabulary (shape + fill conveys state; color comes from status-color):
 *   ○ idle / pending / draft / paused
 *   ◐ active / running / in_progress / connecting
 *   ● solid success / connected / heading-has-active
 *   ✓ completed / ready (overlay check)
 *   ✗ failed / blocked / error
 *   ⊘ cancelled / disabled / deleted
 *   ├─ └─ tree chrome (board lists)
 *   ⛓ dependency suffix
 *
 * Always leave a gap between glyph and label via `withIcon()`.
 */

/** Braille spinner for live footer ticks. */
export const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinFrame(tick = 0): string {
	return SPIN_FRAMES[Math.abs(tick) % SPIN_FRAMES.length]!;
}

/** Soft pulse for alerts — stays in the circle family. */
export const ALERT_FRAMES = ["●", "○"] as const;

export function alertFrame(tick = 0): string {
	return ALERT_FRAMES[Math.abs(tick) % ALERT_FRAMES.length]!;
}

/** Single space between icon and following text (rpiv-todo row style). */
export const ICON_GAP = " ";

/** `◐ label` — never glue glyph to text. */
export function withIcon(icon: string, label: string, gap = ICON_GAP): string {
	if (!icon) return label;
	if (!label) return icon;
	return `${icon}${gap}${label}`;
}

export const ICONS = {
	idle: "○",
	active: "◐",
	solid: "●",
	done: "✓",
	fail: "✗",
	cancel: "⊘",
	deps: "⛓",
	treeBranch: "├─",
	treeLast: "└─",
	/** @deprecated alias — use idle */
	todos: "○",
	todoPending: "○",
	todoActive: "◐",
	todoDone: "✓",
	todoBlocked: "✗",
	todoDeps: "⛓",
	goalActive: "●",
	goalPaused: "○",
	goalBlocked: "✗",
	planDraft: "○",
	planReady: "✓",
	planExecuting: "◐",
	tasks: "◐",
	tasksIdle: "○",
	jobs: "◐",
	jobsIdle: "○",
	mcpOk: "●",
	mcpConn: "◐",
	mcpErr: "✗",
	mcpOff: "○",
	mcpDisabled: "⊘",
	rewind: "○",
} as const;

/** Generic workflow status → geometric glyph. */
export function statusGlyph(status: string): string {
	switch (status) {
		case "in_progress":
		case "running":
		case "executing":
		case "connecting":
		case "terminating":
		case "active":
			return ICONS.active;
		case "completed":
		case "ready":
		case "answered":
		case "exited":
			return ICONS.done;
		case "connected":
			return ICONS.solid;
		case "failed":
		case "error":
		case "killed":
		case "blocked":
			return ICONS.fail;
		case "cancelled":
		case "discarded":
		case "disabled":
		case "deleted":
			return ICONS.cancel;
		default:
			return ICONS.idle;
	}
}

export function todoStatusGlyph(status: string): string {
	return statusGlyph(status);
}

export function goalIcon(status: string): string {
	if (status === "blocked") return ICONS.goalBlocked;
	if (status === "paused") return ICONS.goalPaused;
	return ICONS.goalActive;
}

export function planIcon(status: string): string {
	if (status === "ready") return ICONS.planReady;
	if (status === "executing") return ICONS.planExecuting;
	return ICONS.planDraft;
}

export function taskIcon(status: string): string {
	return statusGlyph(status);
}

export function jobIcon(status: string): string {
	return statusGlyph(status);
}

export function mcpIcon(status: string, enabled = true): string {
	if (!enabled) return ICONS.mcpDisabled;
	switch (status) {
		case "connected":
			return ICONS.mcpOk;
		case "connecting":
			return ICONS.mcpConn;
		case "error":
			return ICONS.mcpErr;
		default:
			return ICONS.mcpOff;
	}
}

/** Colored glyph + spaced label for board/dashboard rows. */
export function themedIconLabel(
	theme: { fg: (color: string, text: string) => string },
	color: string,
	icon: string,
	label: string,
): string {
	return `${theme.fg(color, icon)}${ICON_GAP}${label}`;
}
