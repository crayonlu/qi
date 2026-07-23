import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import {
	BTW_SYSTEM_PROMPT,
	CROSS_SESSION_HINT_LIMIT,
	clearSessionHistory,
	getSessionHistory,
	invalidateSnapshot,
	resetBtwRuntimeForTests,
	userMessageText,
} from "../../src/extensions/qi-workflow/runtime/btw-side-turn.ts";

function fakeCtx(sessionKey: string): ExtensionContext {
	return {
		sessionManager: {
			getSessionFile: () => sessionKey,
			getSessionId: () => sessionKey,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

function fakeTurn(q: string, a: string, ts: number) {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: q }],
		timestamp: ts,
	};
	const assistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: a }],
		stopReason: "stop",
		api: "openai-completions",
		provider: "test",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: ts + 1,
	} as AssistantMessage;
	return { userMessage, assistantMessage };
}

describe("qi-workflow /btw runtime (rpiv-btw parity)", () => {
	afterEach(() => {
		resetBtwRuntimeForTests();
	});

	it("keeps process-global per-session history and clears it", () => {
		const ctx = fakeCtx("sess-a.jsonl");
		const hist = getSessionHistory(ctx);
		hist.push(fakeTurn("q1", "a1", 1));
		hist.push(fakeTurn("q2", "a2", 2));
		expect(getSessionHistory(ctx)).toHaveLength(2);
		expect(userMessageText(getSessionHistory(ctx)[0]!.userMessage)).toBe("q1");

		clearSessionHistory(ctx);
		expect(getSessionHistory(ctx)).toHaveLength(0);
	});

	it("isolates history by session file key", () => {
		const a = fakeCtx("a.jsonl");
		const b = fakeCtx("b.jsonl");
		getSessionHistory(a).push(fakeTurn("only-a", "x", 1));
		expect(getSessionHistory(a)).toHaveLength(1);
		expect(getSessionHistory(b)).toHaveLength(0);
	});

	it("invalidates snapshot without throwing on plain ctx", () => {
		const ctx = fakeCtx("snap.jsonl");
		invalidateSnapshot(ctx);
	});

	it("embeds mature system prompt and cross-session hint limit", () => {
		expect(BTW_SYSTEM_PROMPT).toContain("You have NO tools");
		expect(BTW_SYSTEM_PROMPT).toContain("MAIN pi session");
		expect(BTW_SYSTEM_PROMPT).toContain("Markdown");
		expect(CROSS_SESSION_HINT_LIMIT).toBe(10);
	});
});
