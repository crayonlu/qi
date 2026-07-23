import { describe, expect, it } from "vitest";
import { agentActivityPreview } from "../../src/extensions/qi-workflow/vendor/subagents/render.ts";
import type { SingleResult } from "../../src/extensions/qi-workflow/vendor/subagents/runner.ts";

function baseResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "general",
		agentSource: "user",
		task: "Research BLAST Premier CS2 tournaments and results in depth",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("subagent collapsed activity preview", () => {
	it("prefers first prose line from finalOutput over dumping the report", () => {
		const preview = agentActivityPreview(
			baseResult({
				finalOutput: "## Research Complete\n\nI've compiled a long report about BLAST.",
			}),
		);
		expect(preview).toBe("Research Complete");
		expect(preview.includes("compiled")).toBe(false);
	});

	it("summarizes last bash tool when there is no final output", () => {
		const preview = agentActivityPreview(
			baseResult({
				recentActivity: [
					{
						type: "toolCall",
						name: "bash",
						args: {
							command: 'curl -sL "https://www.hltv.org/results?event=123"\necho more',
						},
					},
				],
				recentActivityTotal: 12,
			}),
		);
		expect(preview.startsWith("$ ")).toBe(true);
		expect(preview.includes("\n")).toBe(false);
	});

	it("falls back to the task text", () => {
		expect(agentActivityPreview(baseResult())).toContain("Research BLAST");
	});
});
