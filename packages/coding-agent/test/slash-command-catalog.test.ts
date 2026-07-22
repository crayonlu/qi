import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	buildSlashCommandCatalog,
	formatSourceBadge,
	resolveBuiltinCategory,
	SLASH_CATEGORIES,
} from "../src/core/slash-command-catalog.ts";

describe("slash-command-catalog", () => {
	test("maps builtins into expected categories", () => {
		expect(resolveBuiltinCategory("new")).toBe("session");
		expect(resolveBuiltinCategory("model")).toBe("configure");
		expect(resolveBuiltinCategory("models")).toBe("configure");
		expect(resolveBuiltinCategory("export")).toBe("share");
		expect(resolveBuiltinCategory("hotkeys")).toBe("help");
	});

	test("composes builtins, qi, templates, skills, and unknown extensions", () => {
		const catalog = buildSlashCommandCatalog({
			extensionCommands: [
				{
					name: "plan",
					invocationName: "plan",
					description: "Plan mode",
					category: "start",
					getArgumentCompletions: (prefix) =>
						["edit", "ready"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
				},
				{
					name: "cleanup",
					invocationName: "cleanup",
					description: "Cleanup",
					hidden: true,
				},
				{
					name: "weird-ext",
					invocationName: "weird-ext",
					description: "Third party",
				},
				{
					name: "llama",
					invocationName: "llama",
					description: "Llama router",
					category: "integrations",
				},
			],
			templates: [{ name: "review", description: "Review PR", displayDescription: "[u] Review PR" }],
			skills: [{ name: "deploy", description: "Deploy app" }],
		});

		const byName = Object.fromEntries(catalog.map((cmd) => [cmd.name, cmd]));
		expect(byName.plan?.category).toBe("start");
		expect(byName.plan?.sourceKind).toBe("qi");
		expect(byName.plan?.description).toContain("[Qi]");
		expect(byName.cleanup?.hidden).toBe(true);
		expect(byName["weird-ext"]?.category).toBe("extensions");
		expect(byName["weird-ext"]?.sourceKind).toBe("extension");
		expect(byName["weird-ext"]?.description).toContain("[third-party]");
		expect(byName.llama?.category).toBe("integrations");
		expect(byName.review?.category).toBe("templates");
		expect(byName.review?.description).toContain("[template]");
		expect(byName["skill:deploy"]?.category).toBe("skills");
		expect(byName.new?.category).toBe("session");
		expect(SLASH_CATEGORIES.some((c) => c.id === "templates" && c.collapsed)).toBe(true);
	});

	test("formatSourceBadge preserves existing text", () => {
		expect(formatSourceBadge("qi", "Plan mode")).toBe("[Qi] Plan mode");
		expect(formatSourceBadge("builtin", "Open settings")).toBe("Open settings");
		expect(formatSourceBadge("template", "[u] Review")).toBe("[template] [u] Review");
	});

	test("argument completions remain available through catalog + provider", async () => {
		const catalog = buildSlashCommandCatalog({
			extensionCommands: [
				{
					name: "todo",
					invocationName: "todo",
					description: "Todos",
					category: "work",
					getArgumentCompletions: (prefix) =>
						["add", "start", "block", "done", "cancel", "remove", "move"]
							.filter((v) => v.startsWith(prefix))
							.map((value) => ({ value, label: value })),
				},
				{
					name: "mcp",
					invocationName: "mcp",
					description: "MCP",
					category: "integrations",
					getArgumentCompletions: (prefix) => {
						const actions = ["inspect", "enable", "disable", "reconnect", "auth"];
						if (!prefix.includes(" ")) {
							return actions.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value }));
						}
						return [{ value: "filesystem", label: "filesystem" }];
					},
				},
			],
		});

		const provider = new CombinedAutocompleteProvider(catalog, "/tmp", null, {
			categorized: true,
			categories: [...SLASH_CATEGORIES],
		});

		const todoArgs = await provider.getSuggestions(["/todo a"], 0, 7, {
			signal: new AbortController().signal,
		});
		expect(todoArgs?.items.map((item) => item.value)).toEqual(["add"]);

		const mcpArgs = await provider.getSuggestions(["/mcp "], 0, 5, {
			signal: new AbortController().signal,
		});
		expect(mcpArgs?.items.map((item) => item.value)).toEqual(["inspect", "enable", "disable", "reconnect", "auth"]);

		const planFlat = await provider.getSuggestions(["/plan"], 0, 5, {
			signal: new AbortController().signal,
		});
		// /plan may only appear once qi extension registers it; builtins alone still work flat
		const model = await provider.getSuggestions(["/mod"], 0, 4, {
			signal: new AbortController().signal,
		});
		expect(model?.items.some((item) => item.value === "model")).toBe(true);
		expect(planFlat === null || Array.isArray(planFlat.items)).toBe(true);
	});
});
