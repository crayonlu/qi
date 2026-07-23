import { describe, expect, it } from "vitest";
import {
	enterTranscriptFocus,
	exitTranscriptFocus,
	getTranscriptFocus,
	isViewingAgent,
	resetTranscriptFocus,
	subscribeTranscriptFocus,
	viewingAgentId,
} from "../../src/extensions/qi-workflow/ui/transcript-focus.ts";

describe("transcript focus state machine", () => {
	it("starts on main and enters/exits agent focus", () => {
		resetTranscriptFocus();
		expect(getTranscriptFocus()).toEqual({ kind: "main" });
		expect(isViewingAgent()).toBe(false);

		enterTranscriptFocus("agt_abc");
		expect(getTranscriptFocus()).toEqual({ kind: "agent", agentId: "agt_abc" });
		expect(viewingAgentId()).toBe("agt_abc");
		expect(isViewingAgent()).toBe(true);

		exitTranscriptFocus();
		expect(getTranscriptFocus()).toEqual({ kind: "main" });
		expect(viewingAgentId()).toBeUndefined();
	});

	it("is idempotent for same agent and exit when already main", () => {
		resetTranscriptFocus();
		const first = enterTranscriptFocus("agt_1");
		const second = enterTranscriptFocus("agt_1");
		expect(second).toEqual(first);

		exitTranscriptFocus();
		const again = exitTranscriptFocus();
		expect(again).toEqual({ kind: "main" });
	});

	it("notifies subscribers on change", () => {
		resetTranscriptFocus();
		let n = 0;
		const unsub = subscribeTranscriptFocus(() => {
			n += 1;
		});
		enterTranscriptFocus("agt_x");
		enterTranscriptFocus("agt_y");
		exitTranscriptFocus();
		unsub();
		enterTranscriptFocus("agt_z");
		expect(n).toBe(3);
		resetTranscriptFocus();
	});
});
