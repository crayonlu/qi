import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import { createEmptyState } from "../../src/extensions/qi-workflow/domain/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("qi-workflow built-in interactive smoke", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		workflowController.store.replaceState(createEmptyState("reset"), false);
	});

	it("loads from builtInExtensions and exercises goal/todo/plan slash path", async () => {
		harness = await createHarness({
			extensionFactories: builtInExtensions,
		});

		const commands = new Set(harness.session.extensionRunner.getRegisteredCommands().map((c) => c.name));
		for (const name of [
			"goal",
			"todo",
			"todos",
			"plan",
			"workflow",
			"tasks",
			"task",
			"jobs",
			"ask",
			"btw",
			"mcp",
			"rewind",
			"cleanup",
		]) {
			expect(commands.has(name)).toBe(true);
		}

		// llama.cpp is hidden; qi-workflow must be present among built-ins
		expect(builtInExtensions.some((ext) => ext.name === "qi-workflow")).toBe(true);

		await harness.session.prompt("/goal Smoke the workflow layer");
		expect(workflowController.getState().goal?.objective).toBe("Smoke the workflow layer");

		await harness.session.prompt("/todo add First smoke todo");
		expect(workflowController.getState().todos.some((t) => t.text.includes("First smoke"))).toBe(true);

		await harness.session.prompt("/plan Explore smoke plan");
		expect(workflowController.getState().plan?.status).toBe("draft");

		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "plan_update"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("plan_update", { steps: ["step one"], discoveries: ["ok"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("updated"),
		]);
		await harness.session.prompt("update plan");
		await harness.session.agent.waitForIdle();
		expect(workflowController.getState().plan?.sections.steps.length).toBeGreaterThan(0);

		await harness.session.prompt("/plan ready");
		expect(workflowController.getState().plan?.status).toBe("ready");

		await harness.session.prompt("/goal pause");
		expect(workflowController.getState().goal?.status).toBe("paused");
		await harness.session.prompt("/goal resume");
		expect(workflowController.getState().goal?.status).toBe("active");
	});
});
