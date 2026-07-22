import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { registerSubagentTools } from "./adapters/index.ts";
import { registerQiWorkflowCommands } from "./commands/register.ts";
import { workflowController } from "./controller.ts";
import { GOAL_INSTRUCTIONS } from "./prompts/goal.ts";
import { PLAN_INSTRUCTIONS } from "./prompts/plan.ts";
import {
	attachGoalContinuation,
	checkpointFiles,
	jobManager,
	MUTATING_TOOLS,
	mcpManager,
	registerBtwLifecycleHooks,
} from "./runtime/index.ts";
import { registerQiWorkflowTools } from "./tools/register.ts";
import { subscribeQiUi } from "./ui/index.ts";

/**
 * Built-in Qi workflow extension: goals, todos, plans, tasks/workflows, jobs,
 * structured questions, /btw, MCP panel, rewind, and cleanup.
 */
export default function qiWorkflowExtension(pi: ExtensionAPI): void {
	workflowController.bindApi(pi);
	registerQiWorkflowCommands(pi);
	registerQiWorkflowTools(pi);
	registerSubagentTools(pi);
	attachGoalContinuation(pi);
	registerBtwLifecycleHooks(pi);
	mcpManager.registerProxyTool(pi);

	let unsubscribeUi: (() => void) | undefined;

	const bindUi = (ctx: ExtensionContext): void => {
		unsubscribeUi?.();
		unsubscribeUi = undefined;
		if (ctx.hasUI) {
			unsubscribeUi = subscribeQiUi(ctx, workflowController);
		}
	};

	pi.on("session_start", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.reason === "new") {
			// New sessions must not inherit prior workflow state.
			workflowController.resetSession(sessionId);
		} else {
			workflowController.restoreFromSession(ctx.sessionManager as SessionManager, sessionId);
			jobManager.recover();
		}
		mcpManager.discover(ctx.cwd);
		mcpManager.registerProxyTool(pi, ctx.cwd);
		bindUi(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribeUi?.();
		unsubscribeUi = undefined;
		void mcpManager.shutdown();
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		if (event.isError) return;
		try {
			await checkpointFiles({
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				trigger: "tool",
				toolName: event.toolName,
				description: `${event.toolName} checkpoint`,
				entryId: ctx.sessionManager.getLeafId() ?? undefined,
			});
		} catch {
			// Checkpoint failures must not block the agent turn.
		}
	});

	pi.on("before_agent_start", (event) => {
		const state = workflowController.getState();
		const append: string[] = [];
		const plan = state.plan;
		if (plan && (plan.status === "draft" || plan.status === "ready")) {
			append.push(PLAN_INSTRUCTIONS);
		}
		if (state.goal?.status === "active") {
			append.push(GOAL_INSTRUCTIONS);
		}
		if (append.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${append.join("\n\n")}`,
		};
	});
}
