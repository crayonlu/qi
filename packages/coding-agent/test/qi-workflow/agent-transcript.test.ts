import { describe, expect, it } from "vitest";
import { agentHistoryToMessages } from "../../src/extensions/qi-workflow/ui/agent-transcript.ts";
import type { ManagedAgent } from "../../src/extensions/qi-workflow/vendor/subagents/registry.ts";

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
		history: [
			{
				task: "Research BLAST",
				output: "## Done\n\nFindings here.",
				startedAt: 10,
				completedAt: 20,
				exitCode: 0,
			},
		],
		mailbox: [],
		...overrides,
	};
}

describe("agentHistoryToMessages", () => {
	it("maps turns to user/assistant message pairs", () => {
		const messages = agentHistoryToMessages(agent());
		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0] && "content" in messages[0] ? messages[0].content : "").toBe("Research BLAST");
		expect(messages[1]?.role).toBe("assistant");
	});

	it("appends currentTask when present", () => {
		const messages = agentHistoryToMessages(agent({ currentTask: "Follow-up dig" }));
		expect(messages.at(-1)?.role).toBe("user");
		const last = messages.at(-1);
		expect(last && "content" in last ? last.content : "").toBe("Follow-up dig");
	});
});
