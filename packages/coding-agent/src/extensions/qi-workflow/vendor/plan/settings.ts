// @ts-nocheck
/**
 * Plan-mode thinking-level constants used by completion/state restore.
 * Tool-policy / bash lockdown intentionally excluded (Qi product direction).
 */

export const PLAN_MODE_SETTINGS_FILE = "pi-plan-mode.json";

export const PLAN_MODE_THINKING_LEVELS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type PlanModeThinkingLevel = (typeof PLAN_MODE_THINKING_LEVELS)[number];
export type PlanModeFixedThinkingLevel = Exclude<PlanModeThinkingLevel, "inherit">;
