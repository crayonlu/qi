import { describe, expect, it } from "vitest";
import {
	agentActivityPreview,
	agentCollapsedPreview,
	renderSubagentCall,
	renderSubagentResult,
} from "../../src/extensions/qi-workflow/vendor/subagents/render.ts";
import type { SingleResult } from "../../src/extensions/qi-workflow/vendor/subagents/runner.ts";

function fakeTheme() {
	return {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	} as never;
}

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

describe("subagent unified call/result layout", () => {
	it("collapsed preview prefers the prompt while running (not tool dumps)", () => {
		const preview = agentCollapsedPreview(
			baseResult({
				exitCode: -1,
				recentActivity: [
					{
						type: "toolCall",
						name: "bash",
						args: { command: 'curl -sL "https://en.wikipedia.org/wiki/BLAST"' },
					},
				],
				recentActivityTotal: 3,
			}),
		);
		expect(preview).toContain("Research BLAST");
		expect(preview.startsWith("$ ")).toBe(false);
	});

	it("hides call tree once execution has started", () => {
		const theme = fakeTheme();
		const before = renderSubagentCall(
			{
				tasks: [
					{ agent: "general", task: "one" },
					{ agent: "general", task: "two" },
				],
			} as never,
			theme,
			{ executionStarted: false },
		);
		const after = renderSubagentCall(
			{
				tasks: [
					{ agent: "general", task: "one" },
					{ agent: "general", task: "two" },
				],
			} as never,
			theme,
			{ executionStarted: true },
		);
		expect(before.render(80).join("\n")).toContain("parallel");
		expect(before.render(80).join("\n")).not.toContain("├─");
		expect(after.render(80)).toEqual([]);
	});

	it("collapsed parallel shows one tree with prompts and Ctrl+O expand hint", () => {
		const theme = fakeTheme();
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "parallel",
					agentScope: "user",
					projectAgentsDir: null,
					results: [
						baseResult({ exitCode: -1, task: "Research and summarize the latest BLAST Premier" }),
						baseResult({ exitCode: -1, task: "Research BLAST.tv Paris Major" }),
					],
				},
			} as never,
			{ expanded: false, isPartial: true },
			theme,
			1,
		);
		const text = component.render(100).join("\n");
		expect(text).toContain("subagent parallel");
		expect(text).toContain("Research and summarize the latest BLAST");
		expect(text).toContain("Ctrl+O to expand prompt");
		expect(text).not.toMatch(/\$ curl/);
	});

	it("expanded parallel includes full prompts", () => {
		const theme = fakeTheme();
		const longPrompt = "Research and summarize the latest BLAST Premier CS2 results across HLTV and Wikipedia";
		const component = renderSubagentResult(
			{
				content: [{ type: "text", text: "running" }],
				details: {
					mode: "parallel",
					agentScope: "user",
					projectAgentsDir: null,
					results: [baseResult({ exitCode: -1, task: longPrompt })],
				},
			} as never,
			{ expanded: true, isPartial: true },
			theme,
			1,
		);
		const text = component.render(120).join("\n");
		expect(text).toContain("Prompt:");
		expect(text).toContain(longPrompt);
	});
});
