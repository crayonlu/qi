/**
 * Plan-mode thinking-level pin from pi-plan-mode.json (thinkingLevel only).
 * Tool-policy / bash lockdown intentionally excluded.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import {
	PLAN_MODE_SETTINGS_FILE,
	PLAN_MODE_THINKING_LEVELS,
	type PlanModeFixedThinkingLevel,
	type PlanModeThinkingLevel,
} from "../vendor/plan/settings.ts";

interface PlanThinkingState {
	applied?: PlanModeFixedThinkingLevel;
	previous?: ThinkingLevel;
	manualOverride: boolean;
}

function readThinkingLevelSetting(): PlanModeThinkingLevel {
	const path = join(getAgentDir(), PLAN_MODE_SETTINGS_FILE);
	if (!existsSync(path)) return "inherit";
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { thinkingLevel?: unknown };
		const level = raw.thinkingLevel ?? "inherit";
		if (typeof level === "string" && (PLAN_MODE_THINKING_LEVELS as readonly string[]).includes(level)) {
			return level as PlanModeThinkingLevel;
		}
	} catch {
		// invalid settings → inherit
	}
	return "inherit";
}

function planIsActive(): boolean {
	const plan = workflowController.getState().plan;
	return !!plan && (plan.status === "draft" || plan.status === "ready" || plan.status === "executing");
}

function fixedLevel(level: PlanModeThinkingLevel): PlanModeFixedThinkingLevel | undefined {
	return level === "inherit" ? undefined : level;
}

/**
 * While a Qi plan is active, optionally pin thinking level from pi-plan-mode.json.
 * Restores prior level on plan exit only if still matching the applied value.
 */
export function attachPlanThinking(pi: ExtensionAPI): void {
	const state: PlanThinkingState = { manualOverride: false };

	const applyIfNeeded = () => {
		if (!planIsActive()) {
			restoreIfOwned();
			return;
		}
		const desired = fixedLevel(readThinkingLevelSetting());
		if (!desired) {
			restoreIfOwned();
			return;
		}
		if (state.manualOverride) return;
		const current = pi.getThinkingLevel();
		if (state.applied === desired && current === desired) return;
		if (!state.applied) state.previous = current;
		pi.setThinkingLevel(desired);
		state.applied = desired;
	};

	const restoreIfOwned = () => {
		if (!state.applied || !state.previous) {
			state.applied = undefined;
			state.previous = undefined;
			state.manualOverride = false;
			return;
		}
		const current = pi.getThinkingLevel();
		if (current === state.applied) {
			pi.setThinkingLevel(state.previous);
		}
		state.applied = undefined;
		state.previous = undefined;
		state.manualOverride = false;
	};

	pi.on("session_start", () => {
		state.applied = undefined;
		state.previous = undefined;
		state.manualOverride = false;
		applyIfNeeded();
	});

	pi.on("before_agent_start", () => {
		applyIfNeeded();
	});

	pi.on("thinking_level_select", (event) => {
		if (state.applied && event.level !== state.applied) {
			state.manualOverride = true;
		}
	});

	pi.on("session_shutdown", () => {
		restoreIfOwned();
	});
}
