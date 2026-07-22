/**
 * Register adopted pi-subagents tool surface on the Qi extension API.
 * UI placement for task/workflow remains Qi dashboard (docs/07); execution
 * goes through vendor executeSubagent / runner.
 */

import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { executeSubagent } from "../vendor/subagents/execution.ts";
import registerSubagents from "../vendor/subagents/subagents.ts";

export function registerSubagentTools(pi: ExtensionAPI): void {
	registerSubagents(pi);
}

export function peekSubagentVendorReachable(): boolean {
	return typeof executeSubagent === "function";
}
