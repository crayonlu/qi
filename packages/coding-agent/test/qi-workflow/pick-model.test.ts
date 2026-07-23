import { describe, expect, it } from "vitest";
import {
	formatModelRef,
	pickSubagentModel,
	pickSubagentModelsForPresets,
} from "../../src/extensions/qi-workflow/vendor/subagents/pick-model.ts";

function model(provider: string, id: string) {
	return { provider, id } as never;
}

function makeCtx(opts: {
	hasUI?: boolean;
	available?: Array<{ provider: string; id: string }>;
	current?: { provider: string; id: string };
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}) {
	const available = (
		opts.available ?? [
			{ provider: "openai", id: "gpt-4o" },
			{ provider: "anthropic", id: "claude-sonnet" },
		]
	).map((m) => model(m.provider, m.id));
	const current = opts.current ? model(opts.current.provider, opts.current.id) : available[0];
	return {
		hasUI: opts.hasUI ?? true,
		model: current,
		modelRegistry: { getAvailable: () => available },
		ui: {
			select: opts.select ?? (async (_title: string, options: string[]) => options[0]),
		},
	} as never;
}

describe("pickSubagentModelsForPresets", () => {
	it("headless inherits session model without UI", async () => {
		const ctx = makeCtx({ hasUI: false, current: { provider: "openai", id: "gpt-4o" } });
		const picked = await pickSubagentModel(ctx);
		expect(formatModelRef(picked)).toBe("openai/gpt-4o");
	});

	it("picks once per unique agent preset name", async () => {
		const titles: string[] = [];
		const ctx = makeCtx({
			select: async (title, options) => {
				titles.push(title);
				if (title.includes("researcher")) return "anthropic/claude-sonnet";
				return options[0];
			},
		});
		const map = await pickSubagentModelsForPresets(ctx, ["coder", "researcher", "coder"]);
		expect(map).toBeDefined();
		expect(map!.size).toBe(2);
		expect(formatModelRef(map!.get("coder"))).toBe("openai/gpt-4o");
		expect(formatModelRef(map!.get("researcher"))).toBe("anthropic/claude-sonnet");
		expect(titles).toEqual(["Model for agent · coder", "Model for agent · researcher"]);
	});

	it("returns undefined when user cancels a pick", async () => {
		const ctx = makeCtx({
			select: async () => undefined,
		});
		const map = await pickSubagentModelsForPresets(ctx, ["a", "b"]);
		expect(map).toBeUndefined();
	});
});
