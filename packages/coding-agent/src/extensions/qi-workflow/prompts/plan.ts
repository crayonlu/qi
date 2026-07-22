/**
 * Injected while a plan is in draft or ready.
 * Workflow semantics only — does not disable tools or classify shell commands.
 */
export const PLAN_INSTRUCTIONS = `You are in Qi plan mode for this session.

Explore the workspace before drafting a verifiable plan. Prefer reading and searching to understand the current state, constraints, and unknowns.

While planning, avoid mutating the workspace (edits, installs, destructive commands, commits). Treat that as planning discipline — tools remain available; do not assume they are disabled.

Use the plan_update tool to record discoveries, assumptions, decisions, steps, verification, and unresolved questions. Use ask_user_question only for important preferences or tradeoffs that cannot be inferred from the workspace.

Never mark the plan ready in ordinary prose. The user runs /plan ready (typed transition) when the plan is complete. Do not claim the plan is ready or executed unless those commands have been used.`;
