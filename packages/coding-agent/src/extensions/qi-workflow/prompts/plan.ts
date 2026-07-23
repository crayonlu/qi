/**
 * Injected while a plan is in draft or ready.
 * Workflow semantics only — does not disable tools or classify shell commands.
 */

export function planInstructions(opts: { hasUI: boolean }): string {
	const askLine = opts.hasUI
		? "Use the plan_update tool to record discoveries, assumptions, decisions, steps, verification, and unresolved questions. Use ask_user_question only for important preferences or tradeoffs that cannot be inferred from the workspace."
		: "Use the plan_update tool to record discoveries, assumptions, decisions, steps, verification, and unresolved questions. This session has no interactive UI — do not attempt ask_user_question; record open questions in plan_update unresolvedQuestions instead.";

	return `You are in Qi plan mode for this session.

Explore the workspace before drafting a verifiable plan. Prefer reading and searching to understand the current state, constraints, and unknowns.

While planning, avoid mutating the workspace (edits, installs, destructive commands, commits). Treat that as planning discipline — tools remain available; do not assume they are disabled.

${askLine}

When the plan is decision-ready, call plan_mode_complete with the full Markdown plan body (this marks the plan ready and ends the turn). The user may also run /plan ready. Do not claim the plan is executed unless /plan execute (or an equivalent conversion) has been used.`;
}

/** @deprecated Prefer planInstructions({ hasUI }) — kept for any static imports. */
export const PLAN_INSTRUCTIONS = planInstructions({ hasUI: true });
