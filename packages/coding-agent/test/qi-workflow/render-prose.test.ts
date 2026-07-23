import { Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderProseOrChrome } from "../../src/extensions/qi-workflow/ui/render-prose.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function summarize(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const opts = { expanded: true, isPartial: false } as const;

describe("renderProseOrChrome", () => {
	it("uses Markdown for expanded AI prose", () => {
		const result = {
			content: [{ type: "text" as const, text: "**Proposed Plan**\n\n- Step one\n- Step two" }],
		};
		const view = renderProseOrChrome(result, opts, fakeTheme(), summarize);
		expect(view).toBeInstanceOf(Markdown);
	});

	it("keeps collapsed chrome as Text", () => {
		const result = {
			content: [{ type: "text" as const, text: "**Proposed Plan**\n\n- Step one" }],
		};
		const view = renderProseOrChrome(result, { expanded: false, isPartial: false }, fakeTheme(), summarize);
		expect(view).toBeInstanceOf(Text);
	});

	it("keeps errors as Text chrome", () => {
		const result = {
			content: [{ type: "text" as const, text: "Error: boom" }],
		};
		const view = renderProseOrChrome(result, opts, fakeTheme(), summarize);
		expect(view).toBeInstanceOf(Text);
	});
});
