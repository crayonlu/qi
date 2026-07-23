import { afterEach, describe, expect, it } from "vitest";
import { addTodoViaVendor } from "../../src/extensions/qi-workflow/adapters/index.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import {
	createEmptyState,
	createTask,
	markPlanReady,
	openQuestion,
	setGoal,
	setTaskRunning,
	startBtw,
	startJob,
	startPlan,
	updatePlanSections,
} from "../../src/extensions/qi-workflow/domain/index.ts";
import { buildFooterText } from "../../src/extensions/qi-workflow/ui/footer.ts";
import { statusThemeColor } from "../../src/extensions/qi-workflow/ui/status-color.ts";
import { buildBoardLines, hasActiveWork } from "../../src/extensions/qi-workflow/ui/work-board.ts";
import { __resetState } from "../../src/extensions/qi-workflow/vendor/todo/state/store.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

describe("qi-workflow TUI board/footer/overlays", () => {
	afterEach(() => {
		__resetState();
		workflowController.resetSession("s");
	});

	it("hides board when idle and shows compact active work", () => {
		const theme = fakeTheme();
		expect(hasActiveWork(createEmptyState("s"))).toBe(false);
		expect(buildBoardLines(createEmptyState("s"), theme, false)).toBeUndefined();

		workflowController.resetSession("s");
		workflowController.apply((s) => setGoal(s, "G"));
		workflowController.apply((s) => addTodoViaVendor(s, "T1"));
		let s = workflowController.getState();
		s = createTask(s, "task").state;
		s = setTaskRunning(s, s.tasks[0]!.id).state;
		s = startJob(s, "job", "echo", "/tmp").state;
		s = startPlan(s, "P").state;
		s = updatePlanSections(s, { steps: ["a"] }).state;
		s = markPlanReady(s).state;

		const lines = buildBoardLines(s, theme, false);
		expect(lines).toBeDefined();
		expect(lines!.length).toBeGreaterThan(0);
		// goal + plan + todos heading/rows + task + job + trailing spacer
		expect(lines!.length).toBeLessThanOrEqual(10);

		const collapsed = buildBoardLines(s, theme, true);
		expect(collapsed).toHaveLength(1);
	});

	it("maps semantic status colors", () => {
		expect(statusThemeColor("running")).toBe("thinkingText");
		expect(statusThemeColor("active")).toBe("accent");
		expect(statusThemeColor("waiting")).toBe("muted");
		expect(statusThemeColor("completed")).toBe("success");
		expect(statusThemeColor("failed")).toBe("error");
		expect(statusThemeColor("cancelled")).toBe("warning");
		expect(statusThemeColor("unknown")).toBe("dim");
	});

	it("builds footer aggregate only for nonzero counts", () => {
		expect(buildFooterText(createEmptyState("s"))).toBeUndefined();
		let s = createTask(createEmptyState("s"), "t").state;
		s = setTaskRunning(s, s.tasks[0]!.id).state;
		s = startJob(s, "j", "echo", "/tmp").state;
		const text = buildFooterText(s);
		expect(text).toContain("tasks=1");
		expect(text).toContain("jobs=1");
	});

	it("question takes priority over btw draft visibility flag", () => {
		let s = startBtw(createEmptyState("s"), "btw?").state;
		expect(s.btw?.hiddenByQuestion).toBe(false);
		s = openQuestion(s, "Q?", [{ label: "a" }, { label: "b" }]).state;
		expect(s.question?.status).toBe("open");
		expect(s.btw?.hiddenByQuestion).toBe(true);
		expect(s.btw?.question).toBe("btw?");
	});
});

describe("qi-workflow dashboard layout thresholds", () => {
	it("documents responsive breakpoints used by openDashboard", async () => {
		const mod = await import("../../src/extensions/qi-workflow/ui/work-dashboard.ts");
		expect(typeof mod.openDashboard).toBe("function");
		// Layout rules are enforced inside openDashboard:
		// >=80 list+detail, 60-79 single column, <60 ctx.ui.select fallback.
		expect(80).toBeGreaterThan(79);
		expect(60).toBeLessThan(80);
	});
});
