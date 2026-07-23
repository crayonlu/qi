/**
 * Compact status icons + spinner frames for Qi board/footer.
 * Prefer readable glyphs that survive NO_COLOR (shape still carries meaning).
 */

/** Braille spinner for live/attention states. */
export const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinFrame(tick = 0): string {
	return SPIN_FRAMES[Math.abs(tick) % SPIN_FRAMES.length]!;
}

/** Pulse for alert attention (fail / blocked / mcp error). */
export const ALERT_FRAMES = ["◆", "◇"] as const;

export function alertFrame(tick = 0): string {
	return ALERT_FRAMES[Math.abs(tick) % ALERT_FRAMES.length]!;
}

export const ICONS = {
	fail: "✕",
	goalActive: "◎",
	goalPaused: "❚❚",
	goalBlocked: "◈",
	planDraft: "✎",
	planReady: "✓",
	planExecuting: "▶",
	todos: "☐",
	todoBlocked: "⚠",
	todoActive: "▸",
	tasks: "▷",
	jobs: "⚙",
	mcpOk: "●",
	mcpErr: "◌",
	mcpConn: "◎",
	rewind: "↩",
} as const;

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
