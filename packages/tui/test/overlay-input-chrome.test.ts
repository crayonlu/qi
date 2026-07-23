import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth } from "../src/index.ts";
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

class TallOverlay implements Component {
	render(): string[] {
		return Array.from({ length: 20 }, (_, i) => `OVERLAY_${i}`);
	}
	invalidate() {}
}

describe("TUI overlay input chrome", () => {
	it("center overlay with bottom margin leaves the last rows clear", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new SimpleContent(["HEADER", ..."x".repeat(20).split(""), "EDITOR"]));
		tui.showOverlay(new TallOverlay(), {
			anchor: "center",
			width: "95%",
			maxHeight: "70%",
			margin: { top: 1, right: 1, bottom: 4, left: 1 },
		});

		tui.start();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		const lastClear = viewport.slice(-4);
		for (const line of lastClear) {
			assert.ok(!line.includes("OVERLAY_"), `input chrome row should be clear, got "${line}"`);
		}

		tui.stop();
	});
});

describe("visibleWidth sanity for panel borders", () => {
	it("ANSI sequences do not contribute to visible width", () => {
		const plain = "hello";
		const colored = `\x1b[32mhello\x1b[0m`;
		assert.equal(visibleWidth(plain), 5);
		assert.equal(visibleWidth(colored), 5);
	});
});
