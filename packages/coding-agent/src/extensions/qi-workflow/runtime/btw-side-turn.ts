/**
 * /btw side turn — clones main session branch messages into an isolated turn.
 * Branch-clone pattern adapted from rpiv-btw (MIT; see vendor/LICENSE.rpiv.md).
 */

import type { Message } from "@earendil-works/pi-ai";
import { completeSimple, type Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../../core/extensions/types.ts";
import { convertToLlm } from "../../../core/messages.ts";
import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import { createAgentSession } from "../../../core/sdk.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { workflowController } from "../controller.ts";
import { startBtw, updateBtwAnswer } from "../domain/index.ts";

const ANSWER_MAX = 8 * 1024;
const BTW_SYSTEM =
	"You are answering a quick side question (/btw). Use the conversation context. Be concise. Do not modify files or call tools.";

export interface BtwSideTurnOptions {
	cwd?: string;
	model?: Model<any>;
	signal?: AbortSignal;
	/** When provided, clone the live session branch into the side turn. */
	ctx?: ExtensionContext | ExtensionCommandContext;
}

function bound(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= ANSWER_MAX) return trimmed;
	return `${trimmed.slice(0, ANSWER_MAX)}\n…[truncated]`;
}

function branchToMessages(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry as { message: Message }).message)
		.filter(Boolean);
	return convertToLlm(agentMessages);
}

/**
 * Run an isolated /btw side turn.
 * Prefer branch-clone + completeSimple when ExtensionContext is available;
 * otherwise fall back to an ephemeral AgentSession (no main-transcript writes).
 */
export async function runBtwSideTurn(question: string, options: BtwSideTurnOptions = {}): Promise<string> {
	const started = workflowController.apply((state) => startBtw(state, question));
	if (!started.ok) throw new Error(started.error);

	const ctx = options.ctx;
	if (ctx?.sessionManager && ctx.model && ctx.modelRegistry) {
		const model = ctx.model;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		if (!auth.apiKey) throw new Error("No API key available for /btw");

		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const messages: Message[] = [
			...branchToMessages(branch),
			{
				role: "user",
				content: [{ type: "text", text: question }],
				timestamp: Date.now(),
			},
		];

		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			const response = await completeSimple(
				model,
				{ systemPrompt: BTW_SYSTEM, messages, tools: [] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
			);
			if (response.stopReason === "aborted") throw new Error("btw aborted");
			if (response.stopReason === "error") {
				throw new Error(response.errorMessage ?? "btw call failed");
			}
			const text =
				typeof response.content === "string"
					? response.content
					: response.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join("");
			const answer = bound(text.trim() || "(no assistant response)");
			const updated = workflowController.apply((state) => updateBtwAnswer(state, answer));
			if (!updated.ok) throw new Error(updated.error);
			return answer;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

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
