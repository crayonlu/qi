import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SimpleContent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

class SimpleOverlay implements Component {
	render(): string[] {
		return ["OVERLAY_TOP", "OVERLAY_MID", "OVERLAY_BOT"];
	}
	invalidate() {}
}

describe("TUI overlay with short content", () => {
	it("should render overlay when content is shorter than terminal height", async () => {
		// Terminal has 24 rows, but content only has 3 lines
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		// Only 3 lines of content
		tui.addChild(new SimpleContent(["Line 1", "Line 2", "Line 3"]));

		// Show overlay centered - should be around row 10 in a 24-row terminal
		const overlay = new SimpleOverlay();
		tui.showOverlay(overlay);

		// Trigger render
		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const hasOverlay = viewport.some((line) => line.includes("OVERLAY"));

		console.log("Terminal rows:", terminal.rows);
		console.log("Content lines: 3");
		console.log("Overlay visible:", hasOverlay);

		if (!hasOverlay) {
			console.log("\nViewport contents:");
			for (let i = 0; i < viewport.length; i++) {
				console.log(`  [${i}]: "${viewport[i]}"`);
			}
		}

		assert.ok(hasOverlay, "Overlay should be visible when content is shorter than terminal");

		tui.stop();
	});

	it("bottom-center overlay keeps short content near the bottom (no half-screen gap)", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);

		tui.addChild(new SimpleContent(["HEADER", "EDITOR"]));
		tui.showOverlay(new SimpleOverlay(), {
			anchor: "bottom-center",
			width: "100%",
			margin: { bottom: 3 },
		});

		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const editorRow = viewport.findIndex((line) => line.includes("EDITOR"));
		const overlayBotRow = viewport.findIndex((line) => line.includes("OVERLAY_BOT"));

		assert.ok(editorRow >= 0, "EDITOR should be visible");
		assert.ok(overlayBotRow >= 0, "OVERLAY_BOT should be visible");
		// Content is bottom-aligned; overlay sits just above the reserved input gap.
		assert.ok(editorRow >= 18, `EDITOR should sit near bottom, got row ${editorRow}`);
		assert.ok(
			overlayBotRow < editorRow,
			`overlay should be above editor (overlay=${overlayBotRow}, editor=${editorRow})`,
		);
		assert.ok(
			editorRow - overlayBotRow <= 5,
			`gap between overlay and editor should be small, got ${editorRow - overlayBotRow}`,
		);

		tui.stop();
	});
});
