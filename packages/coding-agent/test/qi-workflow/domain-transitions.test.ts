import { describe, expect, it } from "vitest";
import {
	addTodo,
	answerQuestion,
	blockGoal,
	blockTodo,
	cancelJob,
	cancelQuestion,
	cancelTodo,
	cancelWorkflow,
	claimContinuation,
	clearContinuationTicket,
	clearGoal,
	completeGoal,
	completeTask,
	completeTodo,
	createEmptyState,
	createTask,
	createWorkflow,
	discardPlan,
	editGoal,
	editPlanGoal,
	executePlanToTodos,
	executePlanToWorkflow,
	failTask,
	finishJob,
	markPlanReady,
	moveTodo,
	openQuestion,
	pauseGoal,
	planFromAssistantProse,
	recoverJobStatuses,
	recoverTaskStatuses,
	recoverWorkflowStatuses,
	removeTodo,
	resumeGoal,
	setGoal,
	setTaskRunning,
	startBtw,
	startJob,
	startPlan,
	startTodo,
	updatePlanSections,
} from "../../src/extensions/qi-workflow/domain/index.ts";

function state() {
	return createEmptyState("sess_test");
}

describe("qi-workflow goal/todo transitions", () => {
	it("sets, edits, pauses, resumes, and clears a goal", () => {
		let s = state();
		const created = setGoal(s, "Ship Qi workflow");
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		s = created.state;
		expect(s.goal?.status).toBe("active");

		const edited = editGoal(s, "Ship Qi workflow v1");
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		s = edited.state;

		const paused = pauseGoal(s);
		expect(paused.ok).toBe(true);
		if (!paused.ok) return;
		s = paused.state;
		expect(s.goal?.status).toBe("paused");

		const resumed = resumeGoal(s);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		s = resumed.state;
		expect(s.goal?.status).toBe("active");

		const cleared = clearGoal(s);
		expect(cleared.ok).toBe(true);
		if (!cleared.ok) return;
		expect(cleared.state.goal).toBeNull();
	});

	it("requires typed evidence for goal completion and blocking", () => {
		let s = setGoal(state(), "Finish").state;
		expect(completeGoal(s, "").ok).toBe(false);
		const done = completeGoal(s, "All acceptance tests green");
		expect(done.ok).toBe(true);
		if (!done.ok) return;
		expect(done.state.goal?.status).toBe("completed");

		s = setGoal(state(), "Finish").state;
		expect(blockGoal(s, "").ok).toBe(false);
		const blocked = blockGoal(s, "Missing API key");
		expect(blocked.ok).toBe(true);
		if (!blocked.ok) return;
		expect(blocked.state.goal?.status).toBe("blocked");
	});

	it("prevents duplicate continuation claim until cleared", () => {
		let s = setGoal(state(), "Continue work").state;
		const first = claimContinuation(s);
		expect(first.ok && first.value).toBeTruthy();
		if (!first.ok || !first.value) return;
		s = first.state;
		const second = claimContinuation(s);
		expect(second.ok && second.value).toBeNull();
		s = clearContinuationTicket(s, first.value.ticket).state;
		const third = claimContinuation(s);
		expect(third.ok && third.value).toBeTruthy();
	});

	it("manages ordered todos", () => {
		let s = setGoal(state(), "Goal").state;
		s = addTodo(s, "A").state;
		s = addTodo(s, "B").state;
		s = addTodo(s, "C").state;
		const a = s.todos.find((t) => t.text === "A")!;
		const b = s.todos.find((t) => t.text === "B")!;
		const c = s.todos.find((t) => t.text === "C")!;
		s = startTodo(s, a.id).state;
		expect(s.todos.find((t) => t.id === a.id)?.status).toBe("in_progress");
		s = blockTodo(s, a.id, "waiting").state;
		expect(s.todos.find((t) => t.id === a.id)?.status).toBe("blocked");
		s = completeTodo(s, a.id, "ok").state;
		expect(s.todos.find((t) => t.id === a.id)?.status).toBe("completed");
		s = cancelTodo(s, b.id).state;
		const moved = moveTodo(s, c.id, 0);
		expect(moved.ok).toBe(true);
		if (!moved.ok) return;
		s = moved.state;
		expect(s.todos.sort((x, y) => x.position - y.position)[0]?.id).toBe(c.id);
		s = removeTodo(s, c.id).state;
		expect(s.todos.find((t) => t.id === c.id)).toBeUndefined();
	});
});

describe("qi-workflow plan transitions", () => {
	it("starts, edits, updates sections, marks ready, discards", () => {
		let s = startPlan(state(), "Explore auth").state;
		expect(s.plan?.status).toBe("draft");
		s = editPlanGoal(s, "Explore auth flows").state;
		s = updatePlanSections(s, { steps: ["Read code", "Draft steps"], discoveries: ["Uses JWT"] }).state;
		expect(markPlanReady(s).ok).toBe(true);
		s = markPlanReady(s).state;
		expect(s.plan?.status).toBe("ready");
		s = discardPlan(createEmptyState("x")).ok ? discardPlan(createEmptyState("x")).state : s;
		const discarded = discardPlan(startPlan(state(), "x").state);
		expect(discarded.ok && discarded.state.plan?.status).toBe("discarded");
	});

	it("rejects ready without steps and rejects prose-driven ready", () => {
		const s = startPlan(state(), "No steps").state;
		expect(markPlanReady(s).ok).toBe(false);
		expect(planFromAssistantProse(s, "Plan is ready").ok).toBe(false);
		expect(executePlanToTodos(s).ok).toBe(false);
	});

	it("executes ready plan to todos and preserves conversion target", () => {
		let s = startPlan(state(), "Implement feature").state;
		s = updatePlanSections(s, { steps: ["One", "Two"] }).state;
		s = markPlanReady(s).state;
		const executed = executePlanToTodos(s);
		expect(executed.ok).toBe(true);
		if (!executed.ok) return;
		expect(executed.state.plan?.status).toBe("executing");
		expect(executed.state.plan?.conversionTarget?.kind).toBe("todos");
		expect(executed.state.todos.map((t) => t.text)).toEqual(["One", "Two"]);
	});

	it("executes ready plan to workflow", () => {
		let s = startPlan(state(), "Implement feature").state;
		s = updatePlanSections(s, { steps: ["Do it"] }).state;
		s = markPlanReady(s).state;
		const wf = createWorkflow(s, "Implement feature", "single", false, ["Do it"]);
		expect(wf.ok).toBe(true);
		if (!wf.ok) return;
		const executed = executePlanToWorkflow(wf.state, wf.value);
		expect(executed.ok).toBe(true);
		if (!executed.ok) return;
		expect(executed.state.plan?.conversionTarget).toEqual({ kind: "workflow", targetId: wf.value.id });
	});

	it("rejects stale revision", () => {
		let s = startPlan(state(), "Rev").state;
		const rev = s.plan!.revision;
		s = editPlanGoal(s, "Rev 2").state;
		expect(editPlanGoal(s, "Rev 3", rev).ok).toBe(false);
	});
});

describe("qi-workflow task/workflow/job recovery", () => {
	it("cancels tasks and workflows durably", () => {
		let s = createWorkflow(state(), "Build", "parallel", true, ["A", "B"]).state;
		const wf = s.workflows[0]!;
		s = setTaskRunning(s, wf.taskIds[0]!, "child1").state;
		s = cancelWorkflow(s, wf.id).state;
		expect(s.workflows[0]?.status).toBe("cancelled");
		expect(s.tasks.every((t) => t.cancelRequested || t.status === "cancelled")).toBe(true);
	});

	it("marks interrupted running work unknown on recover", () => {
		let s = createTask(state(), "Child").state;
		const taskId = s.tasks[0]!.id;
		s = setTaskRunning(s, taskId, "child").state;
		s = startJob(s, "build", "echo hi", "/tmp").state;
		s = createWorkflow(s, "W", "single", false, ["X"]).state;
		s = { ...s, workflows: s.workflows.map((w) => ({ ...w, status: "running" as const })) };

		s = recoverTaskStatuses(s).state;
		s = recoverWorkflowStatuses(s).state;
		s = recoverJobStatuses(s).state;
		expect(s.tasks[0]?.status).toBe("unknown");
		expect(s.jobs[0]?.status).toBe("unknown");
		expect(s.workflows.every((w) => w.status === "unknown" || w.status === "pending")).toBe(true);
	});

	it("finishes and cancels jobs", () => {
		let s = startJob(state(), "test", "sleep 1", "/tmp").state;
		const id = s.jobs[0]!.id;
		s = cancelJob(s, id).state;
		expect(s.jobs[0]?.status).toBe("terminating");
		s = finishJob(s, id, "killed", 137).state;
		expect(s.jobs[0]?.status).toBe("killed");
	});

	it("completes and fails tasks", () => {
		let s = createTask(state(), "T").state;
		const id = s.tasks[0]!.id;
		s = completeTask(s, id, "done").state;
		expect(s.tasks[0]?.status).toBe("completed");
		s = createTask(s, "T2").state;
		const id2 = s.tasks[1]!.id;
		s = failTask(s, id2, "boom").state;
		expect(s.tasks[1]?.status).toBe("failed");
	});
});

describe("qi-workflow question and btw priority", () => {
	it("opens, answers, and cancels questions", () => {
		let s = openQuestion(state(), "Pick color?", [{ label: "red" }, { label: "blue" }]).state;
		expect(s.question?.status).toBe("open");
		s = answerQuestion(s, ["red"]).state;
		expect(s.question?.status).toBe("answered");

		s = openQuestion(state(), "Pick?", [{ label: "a" }, { label: "b" }]).state;
		s = cancelQuestion(s).state;
		expect(s.question?.status).toBe("cancelled");
	});

	it("hides btw when question opens and blocks new btw while question open", () => {
		let s = startBtw(state(), "side question").state;
		expect(s.btw?.hiddenByQuestion).toBe(false);
		s = openQuestion(s, "blocking?", [{ label: "yes" }, { label: "no" }]).state;
		expect(s.btw?.hiddenByQuestion).toBe(true);
		expect(startBtw(s, "another").ok).toBe(false);
	});
});
