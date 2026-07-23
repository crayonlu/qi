import { describe, expect, it } from "vitest";
import { buildGoalCompleteToolResultText } from "../../src/extensions/qi-workflow/vendor/goal/prompts.ts";

describe("goal_complete wrap-up tool result", () => {
	it("keeps the turn open with a user-visible wrap-up instruction", () => {
		const text = buildGoalCompleteToolResultText("All focused tests pass");
		expect(text).toContain("Goal complete: All focused tests pass");
		expect(text).toContain("short visible wrap-up");
		expect(text).toContain("not the end of the user conversation");
		expect(text).toContain("Do not call more tools");
		expect(text).not.toContain("Next goal queued");
	});

	it("mentions queued next goal without telling the model to start it", () => {
		const text = buildGoalCompleteToolResultText("Ship auth", {
			nextQueued: "Ship billing",
		});
		expect(text).toContain("Next goal queued: Ship billing");
		expect(text).toContain("Do not start the next goal yourself");
	});
});
