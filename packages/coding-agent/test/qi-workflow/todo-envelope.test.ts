import { describe, expect, it } from "vitest";
import type { TaskState } from "../../src/extensions/qi-workflow/vendor/todo/state/state.ts";
import { applyTaskMutation } from "../../src/extensions/qi-workflow/vendor/todo/state/state-reducer.ts";
import { formatContent } from "../../src/extensions/qi-workflow/vendor/todo/tool/response-envelope.ts";

function stateWithOne(subject = "Research CS2 Blast teams"): TaskState {
	return {
		nextId: 5,
		tasks: [
			{
				id: 4,
				subject,
				status: "in_progress",
				activeForm: "Researching",
			},
		],
	};
}

describe("todo response envelope copy", () => {
	it("includes subject when status transitions", () => {
		const before = stateWithOne();
		const { state, op } = applyTaskMutation(before, "update", { id: 4, status: "completed" });
		expect(op.kind).toBe("update");
		const text = formatContent(op, state);
		expect(text).toBe("Updated #4: Research CS2 Blast teams (in_progress → completed)");
	});

	it("includes subject on no-op update", () => {
		const before = stateWithOne();
		const { state, op } = applyTaskMutation(before, "update", { id: 4, status: "in_progress" });
		expect(op.kind).toBe("update");
		if (op.kind !== "update") return;
		expect(op.changed).toBe(false);
		const text = formatContent(op, state);
		expect(text).toContain("Research CS2 Blast teams");
		expect(text).toContain("No change");
	});
});
