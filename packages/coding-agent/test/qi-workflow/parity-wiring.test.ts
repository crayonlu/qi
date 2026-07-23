import { afterEach, describe, expect, it } from "vitest";
import { asActive, projectGoal, setGoalViaVendor } from "../../src/extensions/qi-workflow/adapters/goal.ts";
import {
	mutateTodoViaVendor,
	peekTodoVendorReachable,
	syncTodoStoreFromBranch,
} from "../../src/extensions/qi-workflow/adapters/todo.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import { createEmptyState } from "../../src/extensions/qi-workflow/domain/index.ts";
import { jobManager } from "../../src/extensions/qi-workflow/runtime/job-manager.ts";
import { mcpManager } from "../../src/extensions/qi-workflow/runtime/mcp-manager.ts";
import { createGoal } from "../../src/extensions/qi-workflow/vendor/goal/runtime.ts";
import { __resetState } from "../../src/extensions/qi-workflow/vendor/todo/state/store.ts";

describe("qi-workflow non-UI parity wiring", () => {
	afterEach(() => {
		__resetState();
		workflowController.resetSession("parity-test");
	});

	it("preserves goal accounting fields through ActiveGoal projection", () => {
		const active = createGoal("ship parity", 100_000, 42);
		active.tokensUsed = 1234;
		active.timeUsedSeconds = 12;
		active.baselineTokens = 40;
		const projected = projectGoal(active);
		expect(projected.tokensUsed).toBe(1234);
		expect(projected.tokenBudget).toBe(100_000);
		expect(projected.timeUsedSeconds).toBe(12);
		expect(projected.baselineTokens).toBe(40);
		const roundTrip = asActive(projected);
		expect(roundTrip.tokensUsed).toBe(1234);
		expect(roundTrip.tokenBudget).toBe(100_000);
	});

	it("setGoalViaVendor does not zero tokensUsed on a fresh goal", () => {
		const state = createEmptyState("parity-test");
		const result = setGoalViaVendor(state, "objective");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.tokensUsed).toBe(0);
		expect(result.value.baselineTokens).toBe(0);
		expect(typeof result.value.id).toBe("string");
	});

	it("todo mutations emit TaskDetails and support blockedBy/activeForm", () => {
		expect(peekTodoVendorReachable()).toBe(true);
		workflowController.resetSession("sess-todo");
		const created = workflowController.apply((s) =>
			mutateTodoViaVendor(s, "create", { subject: "A", activeForm: "Doing A" }),
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value.details.tasks.length).toBe(1);
		expect(created.value.details.nextId).toBeGreaterThan(1);
		const aId = created.value.details.tasks[0]!.id;

		const dep = workflowController.apply((s) => mutateTodoViaVendor(s, "create", { subject: "B", blockedBy: [aId] }));
		expect(dep.ok).toBe(true);
		if (!dep.ok) return;
		const b = dep.value.details.tasks.find((t) => t.subject === "B");
		expect(b?.blockedBy).toEqual([aId]);

		const started = workflowController.apply((s) =>
			mutateTodoViaVendor(s, "update", { id: aId, status: "in_progress", activeForm: "Working" }),
		);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.value.details.tasks.find((t) => t.id === aId)?.activeForm).toBe("Working");
	});

	it("syncTodoStoreFromBranch restores vendor store from toolResult details", () => {
		workflowController.resetSession("sess-replay");
		const created = workflowController.apply((s) => mutateTodoViaVendor(s, "create", { subject: "persist me" }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const details = created.value.details;

		__resetState();
		const branch = [
			{
				type: "message",
				message: { role: "toolResult", toolName: "todo", details },
			},
		];
		syncTodoStoreFromBranch({
			sessionManager: {
				getSessionId: () => "sess-replay",
				getBranch: () => branch,
			},
		});
		expect(workflowController.getState().todos.some((t) => t.text === "persist me")).toBe(true);
	});

	it("exposes process write and MCP interactive configure helpers", () => {
		expect(typeof jobManager.write).toBe("function");
		expect(typeof mcpManager.configureInteractive).toBe("function");
		expect(typeof mcpManager.hasInteractiveCapabilitiesConfigured).toBe("function");
	});
});
