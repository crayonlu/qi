import { describe, expect, it } from "vitest";
import { addTodoViaVendor, mutateTodoViaVendor } from "../../src/extensions/qi-workflow/adapters/index.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import {
	createEmptyState,
	moveTodo,
	openQuestion,
	setBoardCollapsed,
	setGoal,
	startPlan,
} from "../../src/extensions/qi-workflow/domain/index.ts";
import { buildFooterText } from "../../src/extensions/qi-workflow/ui/footer.ts";
import { buildBoardLines, hasActiveWork } from "../../src/extensions/qi-workflow/ui/work-board.ts";
import { __resetState } from "../../src/extensions/qi-workflow/vendor/todo/state/store.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
	} as unknown as Theme;
}

describe("qi-workflow UI projections", () => {
	it("shows draft plan and goal usage on board; /board expand hint when collapsed", () => {
		__resetState();
		workflowController.resetSession("ui-board");
		workflowController.apply((s) => setGoal(s, "Ship UI"));
		const g = workflowController.getState().goal!;
		workflowController.store.replaceState(
			{
				...workflowController.getState(),
				goal: { ...g, tokensUsed: 12, tokenBudget: 100 },
			},
			false,
		);
		workflowController.apply((s) => startPlan(s, "Draft plan"));
		expect(hasActiveWork(workflowController.getState())).toBe(true);
		const lines = buildBoardLines(workflowController.getState(), fakeTheme(), false);
		expect(lines?.some((l) => l.includes("plan:draft"))).toBe(true);
		expect(lines?.some((l) => l.includes("12/100"))).toBe(true);

		workflowController.apply((s) => setBoardCollapsed(s, true));
		const collapsed = buildBoardLines(workflowController.getState(), fakeTheme(), true);
		expect(collapsed?.[0]).toContain("/board expand");
	});

	it("footer includes goal/plan/todo/mcp/rw signals", () => {
		const state = createEmptyState("footer");
		state.goal = {
			id: "g1",
			objective: "O",
			status: "active",
			todoIds: [],
			iteration: 1,
			tokensUsed: 5,
			tokenBudget: 50,
			timeUsedSeconds: 0,
			baselineTokens: 0,
			summary: "O",
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
		};
		state.plan = {
			id: "p1",
			goal: "P",
			status: "ready",
			sections: {
				discoveries: [],
				assumptions: [],
				decisions: [],
				steps: ["a"],
				verification: [],
				unresolvedQuestions: [],
			},
			summary: "P",
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
		};
		state.todos = [
			{
				id: "todo_1",
				text: "T",
				status: "pending",
				position: 0,
				taskIds: [],
				summary: "T",
				createdAt: 1,
				updatedAt: 1,
				revision: 1,
			},
		];
		state.mcpServers = [
			{
				id: "m1",
				name: "s",
				status: "connecting",
				transport: "stdio",
				toolCount: 0,
				enabled: true,
				summary: "s",
				createdAt: 1,
				updatedAt: 1,
				revision: 1,
			},
		];
		state.rewindCheckpoints = [
			{
				id: "rw1",
				label: "resume",
				summary: "resume",
				createdAt: 1,
				updatedAt: 1,
				revision: 1,
			},
		];
		const text = buildFooterText(state);
		expect(text).toContain("goal:active");
		expect(text).toContain("plan:ready");
		expect(text).toContain("todos=1");
		expect(text).toContain("mcp=");
		expect(text).toContain("rw=1");
	});

	it("todo detail fields project and dashboard move updates position", () => {
		__resetState();
		workflowController.resetSession("ui-todo");
		workflowController.apply((s) =>
			mutateTodoViaVendor(s, "create", {
				subject: "A",
				description: "desc",
				owner: "alice",
				activeForm: "Doing A",
			}),
		);
		workflowController.apply((s) => addTodoViaVendor(s, "B"));
		const a = workflowController.getState().todos.find((t) => t.text === "A")!;
		expect(a.description).toBe("desc");
		expect(a.owner).toBe("alice");
		const moved = workflowController.apply((s) => moveTodo(s, a.id, 1));
		expect(moved.ok).toBe(true);
		expect(workflowController.getState().todos.sort((x, y) => x.position - y.position)[1]?.text).toBe("A");
	});

	it("openQuestion accepts preview and progress metadata", () => {
		const s = createEmptyState("q");
		const opened = openQuestion(
			s,
			"Pick?",
			[
				{ label: "A", description: "a", preview: "prev-a" },
				{ label: "B", description: "b" },
			],
			{ header: "Pick", questionIndex: 1, questionCount: 2 },
		);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.value.options[0]?.preview).toBe("prev-a");
		expect(opened.value.questionIndex).toBe(1);
		expect(opened.value.questionCount).toBe(2);
	});
});
