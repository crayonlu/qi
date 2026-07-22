/**
 * Thin Qi adapter over adopted pi-plan-mode completion/state helpers.
 */

import { normalizePlanModeCompletion, PLAN_MODE_COMPLETE_TOOL_NAME } from "../vendor/plan/completion-tool.ts";
import { type PlanModeState, restorePlanModeState } from "../vendor/plan/state.ts";

export function normalizePlanBody(plan: string): { ok: true; plan: string } | { ok: false; error: string } {
	return normalizePlanModeCompletion({ plan });
}

export function restorePlanFromSessionEntries(entries: unknown[], stateEntryType = "plan-mode-state"): PlanModeState {
	return restorePlanModeState(entries, stateEntryType);
}

export function peekPlanVendorReachable(): boolean {
	const result = normalizePlanModeCompletion({ plan: "# Plan\n\nDo the thing." });
	return result.ok === true && result.plan.includes("Do the thing");
}

export { PLAN_MODE_COMPLETE_TOOL_NAME };
