import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { WorkflowController } from "../../src/extensions/qi-workflow/controller.ts";
import {
	addTodo,
	createEmptyState,
	markPlanReady,
	QI_STATE_CUSTOM_TYPE,
	setGoal,
	startPlan,
	updatePlanSections,
} from "../../src/extensions/qi-workflow/domain/index.ts";
import {
	loadStateFromSession,
	persistState,
	sanitizeRestoredState,
} from "../../src/extensions/qi-workflow/persistence/session-store.ts";

describe("qi-workflow session persistence", () => {
	it("persists and restores goal/todo/plan for the same session id", () => {
		const sm = SessionManager.inMemory(process.cwd());
		const sessionId = sm.getSessionId();
		const controller = new WorkflowController();
		controller.bindApi({
			appendEntry: (customType, data) => {
				sm.appendCustomEntry(customType, data);
			},
		} as ExtensionAPI);
		controller.resetSession(sessionId);

		expect(controller.apply((s) => setGoal(s, "Persist me")).ok).toBe(true);
		expect(controller.apply((s) => addTodo(s, "Todo 1")).ok).toBe(true);
		expect(controller.apply((s) => startPlan(s, "Plan goal")).ok).toBe(true);
		expect(controller.apply((s) => updatePlanSections(s, { steps: ["step"] })).ok).toBe(true);
		expect(controller.apply((s) => markPlanReady(s)).ok).toBe(true);

		const loaded = loadStateFromSession(sm, sessionId);
		expect(loaded.goal?.objective).toBe("Persist me");
		expect(loaded.todos).toHaveLength(1);
		expect(loaded.plan?.status).toBe("ready");
		expect(loaded.sessionId).toBe(sessionId);
	});

	it("does not inherit state into a different session id", () => {
		const sm = SessionManager.inMemory(process.cwd());
		const sessionId = sm.getSessionId();
		const goalResult = setGoal(createEmptyState(sessionId), "Old");
		expect(goalResult.ok).toBe(true);
		if (!goalResult.ok) return;
		persistState((type, data) => sm.appendCustomEntry(type, data), goalResult.state);

		const other = loadStateFromSession(sm, "different_session");
		expect(other.goal).toBeNull();
		expect(other.sessionId).toBe("different_session");
	});

	it("sanitizeRestoredState demotes running work after restart", () => {
		const base = createEmptyState("s1");
		const dirty = {
			...base,
			tasks: [
				{
					id: "task_1",
					goal: "x",
					summary: "x",
					status: "running" as const,
					attached: false,
					cancelRequested: false,
					createdAt: 1,
					updatedAt: 1,
					revision: 1,
				},
			],
			jobs: [
				{
					id: "job_1",
					name: "j",
					command: "echo",
					cwd: "/tmp",
					summary: "j",
					status: "running" as const,
					outputBytes: 0,
					cancelRequested: false,
					createdAt: 1,
					updatedAt: 1,
					revision: 1,
				},
			],
		};
		const cleaned = sanitizeRestoredState(dirty);
		expect(cleaned.tasks[0]?.status).toBe("unknown");
		expect(cleaned.jobs[0]?.status).toBe("unknown");
	});

	it("writes qi-workflow-state custom entries", () => {
		const sm = SessionManager.inMemory(process.cwd());
		persistState((type, data) => sm.appendCustomEntry(type, data), createEmptyState(sm.getSessionId()));
		const entries = sm.getBranch().filter((e) => e.type === "custom" && e.customType === QI_STATE_CUSTOM_TYPE);
		expect(entries.length).toBeGreaterThan(0);
	});
});
