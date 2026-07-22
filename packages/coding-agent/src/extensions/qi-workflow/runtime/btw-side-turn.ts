import type { Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import { createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { workflowController } from "../controller.ts";
import { startBtw, updateBtwAnswer } from "../domain/index.ts";

const ANSWER_MAX = 8 * 1024;

export interface BtwSideTurnOptions {
	cwd?: string;
	model?: Model<any>;
	signal?: AbortSignal;
}

function bound(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= ANSWER_MAX) return trimmed;
	return `${trimmed.slice(0, ANSWER_MAX)}\n…[truncated]`;
}

/**
 * Run an isolated /btw side turn in an ephemeral in-memory AgentSession.
 * Must not write to the main transcript (no pi.sendUserMessage).
 */
export async function runBtwSideTurn(question: string, options: BtwSideTurnOptions = {}): Promise<string> {
	const started = workflowController.apply((state) => startBtw(state, question));
	if (!started.ok) throw new Error(started.error);

	const cwd = options.cwd ?? process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: options.model,
		sessionManager,
		settingsManager,
		resourceLoader,
	});

	const onAbort = () => {
		void session.abort();
	};
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		await session.prompt(question);
		await session.waitForIdle();
		const answer = bound(session.getLastAssistantText() ?? "(no assistant response)");
		const updated = workflowController.apply((state) => updateBtwAnswer(state, answer));
		if (!updated.ok) throw new Error(updated.error);
		return answer;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}

export interface AttachBtwSummaryOptions {
	/** When true, also append a custom message with type qi-btw-attach (explicit user attach only). */
	attach?: boolean;
	notify?: boolean;
}

type BtwAttachTarget = ExtensionContext | ExtensionAPI;

function getUi(target: BtwAttachTarget): ExtensionContext["ui"] | undefined {
	return "ui" in target ? target.ui : undefined;
}

function getSendMessage(target: BtwAttachTarget): ExtensionAPI["sendMessage"] | undefined {
	if ("sendMessage" in target && typeof target.sendMessage === "function") return target.sendMessage.bind(target);
	return undefined;
}

/**
 * Surface the current /btw answer to the user without dumping the full side-turn into the LLM transcript
 * unless attach=true was explicitly requested.
 */
export function attachBtwSummary(ctx: BtwAttachTarget, options: AttachBtwSummaryOptions = {}): string | undefined {
	const btw = workflowController.getState().btw;
	const ui = getUi(ctx);
	if (!btw?.answer) {
		if (options.notify !== false) ui?.notify("No /btw answer to attach", "warning");
		return undefined;
	}

	const summary = btw.answer.length > 400 ? `${btw.answer.slice(0, 400).trimEnd()}…` : btw.answer;

	if (options.notify !== false) {
		ui?.notify(`btw: ${summary}`, "info");
	}

	if (options.attach) {
		const sendMessage = getSendMessage(ctx);
		sendMessage?.(
			{
				customType: "qi-btw-attach",
				content: summary,
				display: true,
				details: { question: btw.question, answer: btw.answer },
			},
			{ triggerTurn: false },
		);
	}

	return summary;
}
