/**
 * Strip ask_user_question from the active tool set when !hasUI (from rpiv-ask-user-question).
 */

import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export function reconcileAskUserQuestionTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const hasTool = active.includes(ASK_USER_QUESTION_TOOL_NAME);
	if (!ctx.hasUI && hasTool) {
		pi.setActiveTools(active.filter((n) => n !== ASK_USER_QUESTION_TOOL_NAME));
	} else if (ctx.hasUI && !hasTool) {
		pi.setActiveTools([...active, ASK_USER_QUESTION_TOOL_NAME]);
	}
}

export function registerAskUserQuestionReconciler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileAskUserQuestionTool(pi, ctx));
}
