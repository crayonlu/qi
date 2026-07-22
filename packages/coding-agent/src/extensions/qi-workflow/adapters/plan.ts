/**
 * Thin Qi adapter over adopted pi-plan-mode completion helpers.
 * Session plan state lives in qi-workflow-state (Qi-native); vendor plan-mode-state restore is unused.
 */

import { normalizePlanModeCompletion, PLAN_MODE_COMPLETE_TOOL_NAME } from "../vendor/plan/completion-tool.ts";

export function normalizePlanBody(plan: string): { ok: true; plan: string } | { ok: false; error: string } {
	return normalizePlanModeCompletion({ plan });
}

export function peekPlanVendorReachable(): boolean {
	const result = normalizePlanModeCompletion({ plan: "# Plan\n\nDo the thing." });
	return result.ok === true && result.plan.includes("Do the thing");
}

export { PLAN_MODE_COMPLETE_TOOL_NAME };
