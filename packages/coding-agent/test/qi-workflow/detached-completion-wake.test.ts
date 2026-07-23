import { describe, expect, it } from "vitest";
import type { AgentTurnCompletion, ManagedAgent } from "../../src/extensions/qi-workflow/vendor/subagents/registry.ts";
import {
	completionDeliveryKey,
	DETACHED_COMPLETION_DELIVERY_OPTIONS,
} from "../../src/extensions/qi-workflow/vendor/subagents/stateful.ts";

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
	return {
		id: "agt_1",
		agent: "general",
		rootId: "agt_1",
		depth: 0,
		children: [],
		state: "completed",
		createdAt: 1,
		updatedAt: 100,
		cwd: "/tmp",
		history: [{ task: "t", output: "done", startedAt: 1, completedAt: 99, exitCode: 0 }],
		mailbox: [],
		...overrides,
	};
}

function completion(overrides: Partial<AgentTurnCompletion> = {}): AgentTurnCompletion {
	return {
		agent: agent(),
		task: "research",
		output: "ok",
		...overrides,
	};
}

describe("detached completion wake delivery", () => {
	it("wakes the root agent via followUp + triggerTurn", () => {
		expect(DETACHED_COMPLETION_DELIVERY_OPTIONS).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
		});
	});

	it("builds an idempotency key from agent id and turn completedAt", () => {
		const key = completionDeliveryKey(completion());
		expect(key).toBe("agt_1:99");
	});

	it("falls back to updatedAt when history is empty", () => {
		const key = completionDeliveryKey(
			completion({
				agent: agent({ history: [], updatedAt: 42 }),
			}),
		);
		expect(key).toBe("agt_1:42");
	});

	it("dedupes the same completion key", () => {
		const seen = new Set<string>();
		const key = completionDeliveryKey(completion());
		expect(seen.has(key)).toBe(false);
		seen.add(key);
		expect(seen.has(completionDeliveryKey(completion()))).toBe(true);
	});
});
