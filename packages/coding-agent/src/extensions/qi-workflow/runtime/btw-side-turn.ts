/**
 * /btw side-turn runtime — mature non-UI behavior from rpiv-btw (MIT;
 * see vendor/LICENSE.rpiv.md). Qi owns overlay/command placement.
 *
 * Process-global per-session history + branch message snapshots (no disk).
 * completeSimple only — never writes into the main transcript.
 */

import type { AssistantMessage, Message, StopReason, UserMessage } from "@earendil-works/pi-ai";
import { completeSimple, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../../core/extensions/types.ts";
import { convertToLlm } from "../../../core/messages.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { workflowController } from "../controller.ts";
import { clearBtw, startBtw, updateBtwAnswer } from "../domain/index.ts";

export const BTW_STATE_KEY = Symbol.for("qi-btw");
export const CROSS_SESSION_HINT_LIMIT = 10;

/** Upstream system prompt text (rpiv-btw prompts/btw-system.txt). */
export const BTW_SYSTEM_PROMPT = `You are answering a quick side question while the user's main pi session continues working.

You are given the user's primary conversation as the message context — treat it as background. Do NOT try to "continue" the assistant's prior work or pick up a tool call mid-flight; the side question is its own self-contained ask.

Answer directly and concisely. Prefer compact bullets or short paragraphs. Cite files, functions, and line numbers when grounding a claim in the context. If the context is insufficient to answer, say so briefly instead of guessing.

You have NO tools available. You will NOT call tools, even if the prior assistant turns demonstrate tool use. Reply in plain text only.

When a "Recent /btw questions across sessions" appendix is present below, treat it as a high-level pattern hint about what the user has been thinking about lately — useful only when the side question explicitly asks about patterns, trends, or recent topics.`;

const MSG_NO_MODEL = "/btw requires an active model";
const ERR_EMPTY_RESPONSE = "/btw returned no text content.";
const errMisconfigured = (label: string, err: string) => `/btw model (${label}) is misconfigured: ${err}`;
const errNoApiKey = (label: string) => `/btw model (${label}) has no API key available.`;
const errCallFailed = (err: string | undefined) => `/btw call failed: ${err ?? "unknown error"}`;
const errCallThrew = (msg: string) => `/btw call threw: ${msg}`;

/** Real messages — stable object references across calls for prompt-cache parity. */
export interface BtwTurn {
	userMessage: UserMessage;
	assistantMessage: AssistantMessage;
}

interface BtwRuntimeState {
	histories: Map<string, BtwTurn[]>;
	snapshots: Map<string, { messages: Message[] }>;
}

export type BtwExecResult =
	| { ok: true; answer: string; userMessage: UserMessage; assistantMessage: AssistantMessage; stopReason: StopReason }
	| { ok: false; error: string; stopReason?: StopReason }
	| { ok: false; aborted: true; stopReason: StopReason };

function getState(): BtwRuntimeState {
	const g = globalThis as unknown as { [k: symbol]: BtwRuntimeState | undefined };
	let state = g[BTW_STATE_KEY];
	if (!state) {
		state = { histories: new Map(), snapshots: new Map() };
		g[BTW_STATE_KEY] = state;
	}
	return state;
}

function getSessionFile(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.sessionManager.getSessionId()}`;
}

function branchToMessages(branch: SessionEntry[]): Message[] {
	const agentMessages = branch
		.filter((e): e is SessionEntry & { type: "message" } => e.type === "message")
		.map((e) => e.message);
	return convertToLlm(agentMessages);
}

export function getSessionHistory(ctx: ExtensionContext): BtwTurn[] {
	const key = getSessionFile(ctx);
	const state = getState();
	let turns = state.histories.get(key);
	if (!turns) {
		turns = [];
		state.histories.set(key, turns);
	}
	return turns;
}

function pushSessionTurn(ctx: ExtensionContext, turn: BtwTurn): void {
	getSessionHistory(ctx).push(turn);
}

export function clearSessionHistory(ctx: ExtensionContext): void {
	getState().histories.set(getSessionFile(ctx), []);
}

function getSnapshot(ctx: ExtensionContext): { messages: Message[] } | undefined {
	return getState().snapshots.get(getSessionFile(ctx));
}

function setSnapshot(ctx: ExtensionContext, snapshot: { messages: Message[] }): void {
	getState().snapshots.set(getSessionFile(ctx), snapshot);
}

export function invalidateSnapshot(ctx: ExtensionContext): void {
	getState().snapshots.delete(getSessionFile(ctx));
}

export function userMessageText(msg: UserMessage): string {
	if (typeof msg.content === "string") return msg.content;
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export function assistantMessageText(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function getCrossSessionHint(): string {
	const allTurns: { q: string; ts: number }[] = [];
	for (const turns of getState().histories.values()) {
		for (const t of turns) {
			allTurns.push({ q: userMessageText(t.userMessage), ts: t.userMessage.timestamp });
		}
	}
	if (allTurns.length === 0) return "";
	const recent = allTurns.sort((a, b) => a.ts - b.ts).slice(-CROSS_SESSION_HINT_LIMIT);
	const lines = recent.map((t, i) => `${i + 1}. ${t.q.replace(/\s+/g, " ").slice(0, 200)}`);
	return `\n\n## Recent /btw questions across sessions (oldest first)\n\n${lines.join("\n")}`;
}

function readBranchMessages(ctx: ExtensionContext): Message[] {
	const cached = getSnapshot(ctx);
	if (cached) return cached.messages;
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];
	return branchToMessages(branch);
}

function buildBtwMessages(ctx: ExtensionContext, userMessage: UserMessage): Message[] {
	const branchMessages = readBranchMessages(ctx);
	const history = getSessionHistory(ctx);
	// Reuse stored real message objects → byte-identical prompt prefix (cache parity).
	const historyMessages: Message[] = history.flatMap((h) => [h.userMessage, h.assistantMessage]);
	return [...branchMessages, ...historyMessages, userMessage];
}

function buildSystemPrompt(): string {
	return BTW_SYSTEM_PROMPT + getCrossSessionHint();
}

function projectHistoryForUi(
	ctx: ExtensionContext,
	question: string,
): Array<{ role: "user" | "assistant"; text: string }> {
	const prior = getSessionHistory(ctx).flatMap((t) => [
		{ role: "user" as const, text: userMessageText(t.userMessage) },
		{ role: "assistant" as const, text: assistantMessageText(t.assistantMessage) },
	]);
	return [...prior, { role: "user", text: question }];
}

/**
 * Execute /btw via completeSimple. Uses an owned AbortController (not ctx.signal).
 */
export async function executeBtw(
	question: string,
	ctx: ExtensionContext,
	controller: AbortController,
): Promise<BtwExecResult> {
	const model = ctx.model;
	if (!model) return { ok: false, error: MSG_NO_MODEL };
	const modelLabel = `${model.provider}:${model.id}`;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { ok: false, error: errMisconfigured(modelLabel, auth.error) };
	if (!auth.apiKey) return { ok: false, error: errNoApiKey(modelLabel) };

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: question }],
		timestamp: Date.now(),
	};
	const messages = buildBtwMessages(ctx, userMessage);
	const systemPrompt = buildSystemPrompt();

	try {
		const response = await completeSimple(
			model,
			{ systemPrompt, messages, tools: [] },
			{ apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal },
		);

		if (response.stopReason === "aborted") {
			return { ok: false, aborted: true, stopReason: response.stopReason };
		}
		if (response.stopReason === "error") {
			return { ok: false, error: errCallFailed(response.errorMessage), stopReason: response.stopReason };
		}

		const answerText = assistantMessageText(response).trim();
		if (!answerText) {
			return { ok: false, error: ERR_EMPTY_RESPONSE, stopReason: response.stopReason };
		}

		return {
			ok: true,
			answer: answerText,
			userMessage,
			assistantMessage: response,
			stopReason: response.stopReason,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (controller.signal.aborted) {
			return { ok: false, aborted: true, stopReason: "aborted" };
		}
		return { ok: false, error: errCallThrew(message) };
	}
}

function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

function safeInvalidateSnapshot(ctx: ExtensionContext): void {
	try {
		invalidateSnapshot(ctx);
	} catch (e) {
		if (!isStaleCtxError(e)) throw e;
	}
}

/** Snapshot branch messages after assistant turns; invalidate on compact/tree. */
export function registerBtwLifecycleHooks(pi: ExtensionAPI): void {
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		if ((msg as AssistantMessage).stopReason === "toolUse") return;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		setSnapshot(ctx, { messages: branchToMessages(branch) });
	});

	pi.on("session_compact", async (_e, ctx) => safeInvalidateSnapshot(ctx));
	pi.on("session_tree", async (_e, ctx) => safeInvalidateSnapshot(ctx));
}

export interface BtwSideTurnOptions {
	cwd?: string;
	model?: Model<any>;
	/** Optional external abort; wired into an owned AbortController (not used as completeSimple signal directly). */
	signal?: AbortSignal;
	ctx?: ExtensionContext | ExtensionCommandContext;
}

/**
 * Run an isolated /btw side turn and project into Qi domain for the overlay.
 * Does not write into the main transcript.
 */
export async function runBtwSideTurn(question: string, options: BtwSideTurnOptions = {}): Promise<string> {
	const ctx = options.ctx;
	if (!ctx?.sessionManager || !ctx.model || !ctx.modelRegistry) {
		throw new Error(MSG_NO_MODEL);
	}

	const priorUi = projectHistoryForUi(ctx, question.trim());
	const started = workflowController.apply((state) => startBtw(state, question.trim(), priorUi));
	if (!started.ok) throw new Error(started.error);

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const result = await executeBtw(question.trim(), ctx, controller);
		if (!result.ok) {
			if ("aborted" in result) throw new Error("btw aborted");
			throw new Error(result.error);
		}
		pushSessionTurn(ctx, {
			userMessage: result.userMessage,
			assistantMessage: result.assistantMessage,
		});
		const updated = workflowController.apply((state) => updateBtwAnswer(state, result.answer));
		if (!updated.ok) throw new Error(updated.error);
		return result.answer;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/** Clear process-global /btw history for the session and Qi draft. */
export function clearBtwHistory(ctx: ExtensionContext): void {
	clearSessionHistory(ctx);
	workflowController.apply((state) => clearBtw(state));
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

/** Test helper: reset process-global /btw maps. */
export function resetBtwRuntimeForTests(): void {
	const g = globalThis as unknown as { [k: symbol]: BtwRuntimeState | undefined };
	g[BTW_STATE_KEY] = { histories: new Map(), snapshots: new Map() };
}

export function peekBtwRuntimeReachable(): boolean {
	return typeof executeBtw === "function" && typeof registerBtwLifecycleHooks === "function";
}
