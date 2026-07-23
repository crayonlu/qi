/**
 * Injected while a goal is active (status === "active").
 */

export function goalInstructions(opts: { hasUI: boolean }): string {
	const askLine = opts.hasUI
		? "Do not claim goal completion or blocking only in ordinary prose — use the typed tools so state persists. Use ask_user_question only when a required execution decision is missing from the workspace."
		: "Do not claim goal completion or blocking only in ordinary prose — use the typed tools so state persists. This session has no interactive UI — do not attempt ask_user_question; call goal_blocked with the missing decision if you cannot proceed.";

	return `You are continuing work toward the active Qi goal for this session.

Stay focused on the goal objective and its todos. Prefer concrete progress and verification over speculation.

When the goal is fully achieved with evidence, call the goal_complete tool with that evidence. When you are blocked and cannot proceed, call goal_blocked with a clear reason.

${askLine}`;
}

/** @deprecated Prefer goalInstructions({ hasUI }). */
export const GOAL_INSTRUCTIONS = goalInstructions({ hasUI: true });
