// @ts-nocheck
/**
 * Interactive subagent model selection from the same available-model set as /model.
 * Agent markdown / settings must not hard-bind a model.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "../pi-coding-agent-shim.ts";

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Ask the user to pick a subagent model from `modelRegistry.getAvailable()`
 * (the same pool /model shows). Headless inherits the parent session model.
 * Returns undefined if the user cancels the picker.
 */
export async function pickSubagentModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
	const available = ctx.modelRegistry.getAvailable();
	const fallback = ctx.model ?? available[0];
	if (!ctx.hasUI) {
		return fallback;
	}
	if (available.length === 0) {
		return fallback;
	}

	const current = ctx.model;
	const options = available.map((model) => {
		const label = modelLabel(model);
		if (current && current.provider === model.provider && current.id === model.id) {
			return `${label} (current session)`;
		}
		return label;
	});

	// Prefer showing the current session model first when present.
	if (current) {
		const currentLabel = `${modelLabel(current)} (current session)`;
		const idx = options.indexOf(currentLabel);
		if (idx > 0) {
			options.splice(idx, 1);
			options.unshift(currentLabel);
		}
	}

	const selected = await ctx.ui.select("Subagent model", options);
	if (!selected) return undefined;

	const cleaned = selected.replace(/ \(current session\)$/, "");
	return available.find((model) => modelLabel(model) === cleaned) ?? fallback;
}

export function formatModelRef(model: Model<Api> | undefined): string | undefined {
	return model ? modelLabel(model) : undefined;
}
