import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import { createEmptyState, setGoal } from "../../src/extensions/qi-workflow/domain/index.ts";
import qiWorkflowExtension from "../../src/extensions/qi-workflow/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("qi-workflow faux provider flows", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		workflowController.store.replaceState(createEmptyState("reset"), false);
	});

	it("registers Qi slash commands and tools on the session", async () => {
		harness = await createHarness({
			extensionFactories: [{ name: "qi-workflow", factory: qiWorkflowExtension }],
		});

		const commands = harness.session.extensionRunner.getRegisteredCommands().map((c) => c.name);
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
			expect(commands).toContain(name);
		}

		const toolNames = harness.session.getAllTools().map((t) => t.name);
		for (const name of ["goal_complete", "goal_blocked", "todo", "plan_update", "ask_user_question", "process"]) {
			expect(toolNames).toContain(name);
		}
	});

	it("completes a goal only via goal_complete tool with evidence", async () => {
		harness = await createHarness({
			extensionFactories: [{ name: "qi-workflow", factory: qiWorkflowExtension }],
		});

		workflowController.apply((s) => setGoal(s, "Ship workflow layer"));
		expect(workflowController.getState().goal?.status).toBe("active");
		const goalId = workflowController.getState().goal!.id;

		harness.session.setActiveToolsByName([
			...harness.session.getActiveToolNames().filter((n) => n !== "bash"),
			"goal_complete",
		]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("goal_complete", { goalId, evidence: "All focused tests pass" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Goal completed with evidence."),
		]);

		await harness.session.prompt("Please complete the goal");
		await harness.session.agent.waitForIdle();

		expect(workflowController.getState().goal?.status).toBe("completed");
		expect(workflowController.getState().goal?.completionEvidence).toContain("focused tests");
	});

	it("does not complete a goal from ordinary assistant prose", async () => {
		harness = await createHarness({
			extensionFactories: [{ name: "qi-workflow", factory: qiWorkflowExtension }],
		});

		workflowController.apply((s) => setGoal(s, "Stay active"));
		harness.setResponses([fauxAssistantMessage("The goal is complete. All done!")]);
		await harness.session.prompt("status?");
		await harness.session.agent.waitForIdle();

		expect(workflowController.getState().goal?.status).toBe("active");
	});

	it("updates plan sections via plan_update tool without marking ready", async () => {
		harness = await createHarness({
			extensionFactories: [{ name: "qi-workflow", factory: qiWorkflowExtension }],
		});

		const { startPlan } = await import("../../src/extensions/qi-workflow/domain/index.ts");
		workflowController.apply((s) => startPlan(s, "Plan auth"));

		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "plan_update"]);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("plan_update", {
					steps: ["Read existing auth", "Draft migration"],
					discoveries: ["Uses session cookies"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Plan draft updated."),
		]);

		await harness.session.prompt("Explore and update the plan");
		await harness.session.agent.waitForIdle();

		const plan = workflowController.getState().plan;
		expect(plan?.status).toBe("draft");
		expect(plan?.sections.steps.length).toBeGreaterThan(0);
	});
});
