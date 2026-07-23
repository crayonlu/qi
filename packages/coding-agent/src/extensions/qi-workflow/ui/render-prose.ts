import { Markdown, Text } from "@earendil-works/pi-tui";
import type { ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { getMarkdownTheme } from "../../../modes/interactive/theme/theme.ts";

function firstText(result: { content?: Array<{ type: string; text?: string }> }): string {
	const part = result.content?.[0];
	return part?.type === "text" && typeof part.text === "string" ? part.text : "";
}

/** Chrome (ids/status) stays Text; AI/model prose uses Markdown when expanded. */
export function renderProseOrChrome(
	result: { content?: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: Theme,
	summarize: (text: string, max: number) => string,
): Text | Markdown {
	const text = firstText(result);
	const err = text.startsWith("Error:") || text.startsWith("Canceled");
	if (err || !text.trim()) {
		return new Text(theme.fg(err ? "error" : "muted", summarize(text || "(no output)", 100)), 0, 0);
	}
	if (!options.expanded) {
		return new Text(theme.fg("success", summarize(text.replace(/\s+/g, " ").trim(), 100)), 0, 0);
	}
	return new Markdown(text, 0, 0, getMarkdownTheme());
}
