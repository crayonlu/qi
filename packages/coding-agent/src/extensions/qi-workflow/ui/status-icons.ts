/**
 * Qi status icons — pure Unicode symbols (no emoji, no Nerd Font PUA).
 * Aligned with the sindresorhus/figures + clisymbols CLI vocabulary so
 * glyphs stay readable under NO_COLOR and common terminal fonts.
 *
 * Refs:
 * - https://github.com/sindresorhus/figures
 * - https://github.com/r-lib/clisymbols
 */

/** Braille spinner (CLI de facto; not emoji). */
export const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinFrame(tick = 0): string {
	return SPIN_FRAMES[Math.abs(tick) % SPIN_FRAMES.length]!;
}

/** Soft pulse for alert attention (circle filled / double). */
export const ALERT_FRAMES = ["◉", "◎"] as const;

export function alertFrame(tick = 0): string {
	return ALERT_FRAMES[Math.abs(tick) % ALERT_FRAMES.length]!;
}

/**
 * Semantic icons (figures mainSymbols-style).
 * Each is a single text-presentation symbol — never emoji codepoints.
 */
export const ICONS = {
	/** figures.cross */
	fail: "✖",
	/** figures.circleFilled — active focus */
	goalActive: "◉",
	/** double vertical bar — paused */
	goalPaused: "‖",
	/** figures.warning */
	goalBlocked: "⚠",
	/** figures.circleDotted — draft / unset */
	planDraft: "◌",
	/** figures.tick */
	planReady: "✔",
	/** figures.pointer */
	planExecuting: "❯",
	/** figures.checkboxOff */
	todos: "☐",
	/** figures.warning */
	todoBlocked: "⚠",
	/** figures.pointerSmall-ish */
	todoActive: "›",
	/** figures.arrowRight */
	tasks: "→",
	/** figures.squareSmallFilled — background work block */
	jobs: "◼",
	/** figures.bullet */
	mcpOk: "●",
	/** figures.cross */
	mcpErr: "✖",
	/** figures.circleDotted — connecting */
	mcpConn: "◌",
	/** figures.arrowLeft — rewind / restore */
	rewind: "←",
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
