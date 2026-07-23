import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import {
	evictTodoSession,
	registerAskUserQuestionReconciler,
	registerSubagentTools,
	syncTodoStoreFromBranch,
} from "./adapters/index.ts";
import { registerQiWorkflowCommands } from "./commands/register.ts";
import { workflowController } from "./controller.ts";
import { planInstructions } from "./prompts/plan.ts";
import {
	attachAutoRewind,
	attachGoalLifecycle,
	attachPlanThinking,
	jobManager,
	mcpManager,
	registerBtwLifecycleHooks,
} from "./runtime/index.ts";
import { registerQiWorkflowTools } from "./tools/register.ts";
import { resetTranscriptFocus, subscribeQiUi } from "./ui/index.ts";

/**
 * Built-in Qi workflow extension.
 * Non-UI mature package behavior is hosted via thin adapters / lifecycle hosts.
 * Qi owns UI placement; intentional exclusions are listed in vendor/THIRD_PARTY_NOTICES.md.
 */
export default function qiWorkflowExtension(pi: ExtensionAPI): void {
	workflowController.bindApi(pi);
	attachGoalLifecycle(pi);
	attachPlanThinking(pi);
	registerQiWorkflowCommands(pi);
	registerQiWorkflowTools(pi);
	registerAskUserQuestionReconciler(pi);
	registerSubagentTools(pi);
	registerBtwLifecycleHooks(pi);
	attachAutoRewind(pi);
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
			workflowController.resetSession(sessionId);
		} else {
			workflowController.restoreFromSession(ctx.sessionManager as SessionManager, sessionId);
			jobManager.recover();
			syncTodoStoreFromBranch(ctx);
		}
		mcpManager.configureInteractive(ctx);
		mcpManager.discover(ctx.cwd);
		mcpManager.registerProxyTool(pi, ctx.cwd);
		bindUi(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		syncTodoStoreFromBranch(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		syncTodoStoreFromBranch(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeUi?.();
		unsubscribeUi = undefined;
		evictTodoSession(ctx.sessionManager.getSessionId());
		jobManager.shutdownKillAll();
		void mcpManager.shutdown();
		resetTranscriptFocus();
	});

	pi.on("before_agent_start", (event, ctx) => {
		const state = workflowController.getState();
		const plan = state.plan;
		if (plan && (plan.status === "draft" || plan.status === "ready")) {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${planInstructions({ hasUI: ctx.hasUI })}`,
			};
		}
	});
}
