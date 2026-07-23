import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { fitCell, renderBoxPanel, renderSplitBoxPanel } from "../../src/extensions/qi-workflow/ui/chrome.ts";
import {
	BOTTOM_OVERLAY,
	CENTER_OVERLAY,
	INPUT_CHROME_ROWS,
	panelMaxHeight,
	panelOverlay,
} from "../../src/extensions/qi-workflow/ui/layout.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

describe("qi panel surface architecture", () => {
	it("sheet is fullscreen covering input; modal reserves input chrome", () => {
		expect(BOTTOM_OVERLAY.anchor).toBe("top-center");
		expect(BOTTOM_OVERLAY.maxHeight).toBe("100%");
		expect(BOTTOM_OVERLAY.margin).toBe(0);
		expect(CENTER_OVERLAY.margin).toMatchObject({ bottom: INPUT_CHROME_ROWS });
		expect(panelOverlay("sheet").anchor).toBe("top-center");
		expect(panelOverlay("modal").anchor).toBe("center");
	});

	it("panelMaxHeight: sheet fills terminal; modal stays under chrome", () => {
		expect(panelMaxHeight(24, "sheet")).toBe(24);
		const h = panelMaxHeight(24, "modal");
		expect(h).toBeLessThanOrEqual(24 - INPUT_CHROME_ROWS - 1);
		expect(h).toBeLessThanOrEqual(Math.floor(24 * 0.7));
	});

	it("fitCell pads by visible columns, not string length", () => {
		const ansi = "\x1b[32m●\x1b[0m name";
		const cell = fitCell(ansi, 12);
		expect(visibleWidth(cell)).toBe(12);
		expect(cell.endsWith(" ")).toBe(true);
	});

	it("renderBoxPanel keeps every row the same visible width and ends with bottom border", () => {
		const th = fakeTheme();
		const lines = renderBoxPanel(th, {
			title: "Test",
			width: 40,
			body: ["\x1b[32mok\x1b[0m plain", "wide 中文 cell"],
			footer: ["hint"],
			maxHeight: 20,
		});
		const widths = lines.map((l) => visibleWidth(l));
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBe(40);
		expect(lines[lines.length - 1]).toContain("╰");
		expect(lines[0]).toContain("╭");
	});

	it("renderBoxPanel truncates body so maxHeight keeps the bottom border", () => {
		const th = fakeTheme();
		const body = Array.from({ length: 40 }, (_, i) => `row ${i}`);
		const lines = renderBoxPanel(th, {
			title: "Tall",
			width: 30,
			body,
			footer: ["esc"],
			maxHeight: 12,
		});
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines[lines.length - 1]).toContain("╰");
		expect(lines.some((l) => l.includes("…"))).toBe(true);
	});

	it("renderBoxPanel fillHeight pads empty body to maxHeight", () => {
		const th = fakeTheme();
		const lines = renderBoxPanel(th, {
			title: "MCP",
			width: 40,
			body: ["one"],
			footer: ["esc"],
			maxHeight: 16,
			fillHeight: true,
		});
		expect(lines.length).toBe(16);
		expect(lines[lines.length - 1]).toContain("╰");
	});

	it("renderSplitBoxPanel junctions stay aligned under ANSI cells", () => {
		const th = fakeTheme();
		const lines = renderSplitBoxPanel(th, {
			title: "Agent View",
			width: 50,
			leftWidth: 18,
			left: ["\x1b[32m●\x1b[0m agent", "  └─ child"],
			right: ["running", "task here"],
			bodyRows: 2,
			footer: "esc close",
		});
		const widths = lines.map((l) => visibleWidth(l));
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBe(50);
		// Mid junction row: ├───┬───┤
		expect(lines[1]).toMatch(/├.+┬.+┤/);
		expect(lines[lines.length - 1]).toContain("╰");
	});
});
