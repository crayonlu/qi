import assert from "node:assert";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider, type SlashCategoryDefinition, type SlashCommand } from "../src/autocomplete.ts";
import { SelectList } from "../src/components/select-list.ts";

const CATEGORIES: SlashCategoryDefinition[] = [
	{ id: "start", label: "Start or continue", order: 10 },
	{ id: "work", label: "Work", order: 20 },
	{ id: "templates", label: "Templates", order: 80, collapsed: true },
	{ id: "skills", label: "Skills", order: 90, collapsed: true },
	{ id: "extensions", label: "Extensions", order: 100, collapsed: true },
];

const COMMANDS: SlashCommand[] = [
	{ name: "plan", description: "Plan mode", category: "start", sourceKind: "qi" },
	{ name: "goal", description: "Set goal", category: "start", sourceKind: "qi" },
	{ name: "workflow", description: "Run workflow", category: "start", sourceKind: "qi" },
	{ name: "todo", description: "Manage todos", category: "work", sourceKind: "qi", aliases: ["todos-alias"] },
	{ name: "ask", description: "Ask question", category: "work", sourceKind: "qi" },
	{ name: "cleanup", description: "Dev cleanup", category: "work", sourceKind: "qi", hidden: true },
	{ name: "review", description: "Review template", category: "templates", sourceKind: "template" },
	{ name: "skill:deploy", description: "Deploy skill", category: "skills", sourceKind: "skill" },
	{ name: "third-party-cmd", description: "External", category: "extensions", sourceKind: "extension" },
];

const getSuggestions = (provider: CombinedAutocompleteProvider, text: string) =>
	provider.getSuggestions([text], 0, text.length, {
		signal: new AbortController().signal,
	});

describe("CombinedAutocompleteProvider categorized slash UX", () => {
	it("shows category landing for empty /", async () => {
		const provider = new CombinedAutocompleteProvider(COMMANDS, "/tmp", null, {
			categorized: true,
			categories: CATEGORIES,
		});
		const result = await getSuggestions(provider, "/");
		assert.ok(result);
		const labels = result!.items.map((item) => item.label);
		assert.ok(labels.includes("Start or continue"));
		assert.ok(labels.includes("Work"));
		assert.ok(labels.some((label) => label.startsWith("Templates (")));
		assert.ok(labels.some((label) => label.startsWith("Skills (")));
		assert.ok(labels.some((label) => label.startsWith("Extensions (")));
		assert.ok(result!.items.every((item) => item.isGroup || item.isHeader));
		assert.ok(!labels.includes("cleanup"));
		assert.ok(!labels.includes("plan"));
	});

	it("expands category on select and Esc returns to landing", async () => {
		const provider = new CombinedAutocompleteProvider(COMMANDS, "/tmp", null, {
			categorized: true,
			categories: CATEGORIES,
		});
		const landing = await getSuggestions(provider, "/");
		const start = landing!.items.find((item) => item.groupId === "start");
		assert.ok(start);

		const applied = provider.applyCompletion(["/"], 0, 1, start!, "/");
		assert.equal(applied.keepOpen, true);
		assert.equal(applied.lines[0], "/");

		const drilled = await getSuggestions(provider, "/");
		assert.ok(drilled!.items.some((item) => item.value === "plan"));
		assert.ok(drilled!.items.some((item) => item.isHeader));
		assert.ok(!drilled!.items.some((item) => item.value === "todo"));

		assert.equal(provider.handleBack(), true);
		const back = await getSuggestions(provider, "/");
		assert.ok(back!.items.every((item) => item.isGroup));
		assert.equal(provider.handleBack(), false);
	});

	it("global fuzzy search groups results with non-selectable headers", async () => {
		const provider = new CombinedAutocompleteProvider(COMMANDS, "/tmp", null, {
			categorized: true,
			categories: CATEGORIES,
		});
		const result = await getSuggestions(provider, "/plan");
		assert.ok(result);
		assert.ok(result!.items.some((item) => item.isHeader && item.label === "Start or continue"));
		assert.ok(result!.items.some((item) => item.value === "plan"));

		const byAlias = await getSuggestions(provider, "/todos-alias");
		assert.ok(byAlias!.items.some((item) => item.value === "todo"));

		const byCategory = await getSuggestions(provider, "/Work");
		assert.ok(byCategory!.items.some((item) => item.value === "todo"));
		assert.ok(byCategory!.items.some((item) => item.value === "ask"));
	});

	it("keeps flat /plan completion working", async () => {
		const provider = new CombinedAutocompleteProvider(COMMANDS, "/tmp", null, {
			categorized: true,
			categories: CATEGORIES,
		});
		const result = await getSuggestions(provider, "/pla");
		const plan = result!.items.find((item) => item.value === "plan");
		assert.ok(plan);
		const applied = provider.applyCompletion(["/pla"], 0, 4, plan!, "/pla");
		assert.equal(applied.lines[0], "/plan ");
		assert.equal(applied.keepOpen, undefined);
	});

	it("omits hidden commands from browser but still resolves argument completions when typed", async () => {
		const provider = new CombinedAutocompleteProvider(
			COMMANDS.map((cmd) =>
				cmd.name === "cleanup"
					? {
							...cmd,
							getArgumentCompletions: (prefix: string) =>
								["--apply"]
									.filter((value) => value.startsWith(prefix))
									.map((value) => ({ value, label: value })),
						}
					: cmd,
			),
			"/tmp",
			null,
			{ categorized: true, categories: CATEGORIES },
		);
		const landing = await getSuggestions(provider, "/");
		assert.ok(!landing!.items.some((item) => item.value === "cleanup" || item.label.includes("cleanup")));
		const search = await getSuggestions(provider, "/cleanup");
		assert.equal(search, null);

		const args = await getSuggestions(provider, "/cleanup --");
		assert.ok(args);
		assert.deepEqual(
			args!.items.map((item) => item.value),
			["--apply"],
		);
	});

	it("expands collapsed Templates when query matches", async () => {
		const provider = new CombinedAutocompleteProvider(COMMANDS, "/tmp", null, {
			categorized: true,
			categories: CATEGORIES,
		});
		const result = await getSuggestions(provider, "/review");
		assert.ok(result!.items.some((item) => item.value === "review"));
		assert.ok(result!.items.some((item) => item.isHeader && item.label === "Templates"));
	});

	it("narrow provider without categories stays flat", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "plan", description: "Plan" },
				{ name: "model", description: "Model" },
			],
			"/tmp",
		);
		const result = await getSuggestions(provider, "/");
		assert.deepEqual(
			result!.items.map((item) => item.value),
			["plan", "model"],
		);
	});
});

describe("SelectList header skipping", () => {
	const theme = {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
		header: (text: string) => text,
	};

	it("skips non-selectable headers when navigating", () => {
		const list = new SelectList(
			[
				{ value: "__header__:start", label: "Start or continue", selectable: false, isHeader: true },
				{ value: "plan", label: "plan", description: "Plan mode" },
				{ value: "__header__:work", label: "Work", selectable: false, isHeader: true },
				{ value: "todo", label: "todo", description: "Todos" },
			],
			5,
			theme,
		);

		assert.equal(list.getSelectedItem()?.value, "plan");
		list.handleInput("\x1b[B"); // down
		assert.equal(list.getSelectedItem()?.value, "todo");
		list.handleInput("\x1b[B");
		assert.equal(list.getSelectedItem()?.value, "plan");
		list.handleInput("\x1b[A"); // up
		assert.equal(list.getSelectedItem()?.value, "todo");
	});
});
