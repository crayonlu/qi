import { afterEach, describe, expect, it } from "vitest";
import {
	addTodoViaVendor,
	blockTodoViaVendor,
	executePlanToTodosViaVendor,
	listTodosViaVendor,
	mutateTodoViaVendor,
	syncTodoStoreFromBranch,
} from "../../src/extensions/qi-workflow/adapters/index.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import {
	createEmptyState,
	markPlanReady,
	startPlan,
	updatePlanSections,
} from "../../src/extensions/qi-workflow/domain/index.ts";
import { QI_TODO_STATE_CUSTOM_TYPE } from "../../src/extensions/qi-workflow/vendor/todo/state/replay.ts";
import { __resetState, getState } from "../../src/extensions/qi-workflow/vendor/todo/state/store.ts";

describe("todo dual-store + replay parity", () => {
	afterEach(() => {
		__resetState();
		workflowController.resetSession("todo-parity");
	});

	it("block reason survives branch replay into vendor + Qi projection", () => {
		workflowController.resetSession("todo-parity");
		const created = workflowController.apply((s) => addTodoViaVendor(s, "Ship dual-store"));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.value.id;

		const blocked = workflowController.apply((s) => blockTodoViaVendor(s, id, "waiting on API key"));
		expect(blocked.ok).toBe(true);
		if (!blocked.ok) return;
		expect(blocked.value.status).toBe("blocked");
		expect(blocked.value.blockReason).toBe("waiting on API key");

		const details = listTodosViaVendor().details;
		__resetState();
		workflowController.store.replaceState(createEmptyState("todo-parity"), true);

		const branch = [
			{
				type: "custom",
				customType: QI_TODO_STATE_CUSTOM_TYPE,
				data: details,
			},
		];
		syncTodoStoreFromBranch({
			sessionManager: {
				getSessionId: () => "todo-parity",
				getBranch: () => branch,
			},
		});

		const after = workflowController.getState().todos.find((t) => t.text === "Ship dual-store");
		expect(after?.status).toBe("blocked");
		expect(after?.blockReason).toBe("waiting on API key");
		expect(getState("todo-parity").tasks.some((t) => t.metadata?.qiBlockReason === "waiting on API key")).toBe(true);
	});

	it("plan→todos creates vendor-backed tasks that replay", () => {
		workflowController.resetSession("todo-parity");
		workflowController.apply((s) => startPlan(s, "Plan auth"));
		workflowController.apply((s) =>
			updatePlanSections(s, {
				steps: ["Add OAuth", "Wire callback"],
			}),
		);
		const ready = workflowController.apply((s) => markPlanReady(s));
		expect(ready.ok).toBe(true);
		const converted = workflowController.apply((s) => executePlanToTodosViaVendor(s));
		expect(converted.ok).toBe(true);
		if (!converted.ok) return;
		expect(converted.value.todos.map((t) => t.text)).toEqual(["Add OAuth", "Wire callback"]);
		expect(listTodosViaVendor().details.tasks.filter((t) => t.status !== "deleted").length).toBe(2);
	});

	it("exposes get/clear/description/owner through vendor mutations", () => {
		workflowController.resetSession("todo-parity");
		const created = workflowController.apply((s) =>
			mutateTodoViaVendor(s, "create", {
				subject: "Owned task",
				description: "longer text",
				owner: "alice",
			}),
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const vendorId = created.value.details.tasks[0]!.id;
		const got = workflowController.apply((s) => mutateTodoViaVendor(s, "get", { id: vendorId }));
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.value.content).toContain("Owned task");
		expect(got.value.content).toContain("alice");

		const cleared = workflowController.apply((s) => mutateTodoViaVendor(s, "clear", {}));
		expect(cleared.ok).toBe(true);
		if (!cleared.ok) return;
		expect(cleared.value.details.tasks.every((t) => t.status === "deleted" || t.status === "completed")).toBe(true);
	});
});
