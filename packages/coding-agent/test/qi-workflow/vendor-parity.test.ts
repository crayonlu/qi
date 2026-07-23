import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtInExtensions } from "../../src/extensions/index.ts";
import {
	addTodoViaVendor,
	mutateTodoViaVendor,
	peekAskVendorReachable,
	peekBtwVendorReachable,
	peekGoalVendorReachable,
	peekMcpVendorReachable,
	peekPlanVendorReachable,
	peekProcessesVendorReachable,
	peekSubagentVendorReachable,
	peekTodoVendorReachable,
	validateAskQuestions,
} from "../../src/extensions/qi-workflow/adapters/index.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import { createEmptyState } from "../../src/extensions/qi-workflow/domain/index.ts";
import { mcpManager } from "../../src/extensions/qi-workflow/runtime/mcp-manager.ts";
import { checkpointFiles } from "../../src/extensions/qi-workflow/runtime/rewind.ts";
import { createGoal } from "../../src/extensions/qi-workflow/vendor/goal/runtime.ts";
import { McpLifecycleManager } from "../../src/extensions/qi-workflow/vendor/mcp/lifecycle.ts";
import { McpServerManager } from "../../src/extensions/qi-workflow/vendor/mcp/server-manager.ts";
import { ProcessManager } from "../../src/extensions/qi-workflow/vendor/processes/manager.ts";
import {
	createCheckpoint,
	loadCheckpointFromRef,
	REF_BASE,
	restoreCheckpoint,
} from "../../src/extensions/qi-workflow/vendor/rewind/core.ts";
import { applyTaskMutation } from "../../src/extensions/qi-workflow/vendor/todo/state/state-reducer.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

describe("qi-workflow vendor reachability", () => {
	it("exposes adopted package cores through adapters", () => {
		expect(peekGoalVendorReachable()).toBe(true);
		expect(peekTodoVendorReachable()).toBe(true);
		expect(peekAskVendorReachable()).toBe(true);
		expect(peekPlanVendorReachable()).toBe(true);
		expect(peekSubagentVendorReachable()).toBe(true);
		expect(peekProcessesVendorReachable()).toBe(true);
		expect(peekMcpVendorReachable()).toBe(true);
		expect(peekBtwVendorReachable()).toBe(true);
	});

	it("calls vendor goal createGoal and todo applyTaskMutation directly", () => {
		const goal = createGoal("parity probe", undefined, 0);
		expect(goal.status).toBe("active");
		const todo = applyTaskMutation({ tasks: [], nextId: 1 }, "create", { subject: "parity todo" });
		expect(todo.op.kind).toBe("create");
	});

	it("ProcessManager is the adopted process implementation", () => {
		const pm = new ProcessManager();
		expect(pm.list()).toEqual([]);
	});

	it("rewind REF_BASE stays refs/pi-checkpoints", () => {
		expect(REF_BASE).toBe("refs/pi-checkpoints");
	});
});

describe("qi-workflow mcp lifecycle integration", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		mcpManager.shutdown();
		workflowController.store.replaceState(createEmptyState("mcp-reset"), false);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("/mcp disable prevents keep-alive reconnect; enable arms it again", () => {
		const cwd = mkdtempSync(join(tmpdir(), "qi-mcp-ka-"));
		dirs.push(cwd);
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: { command: "true", lifecycle: "keep-alive" },
				},
			}),
			"utf-8",
		);

		mcpManager.discover(cwd);
		expect(mcpManager.isKeepAliveMarked("demo")).toBe(true);

		mcpManager.disable("demo");
		expect(mcpManager.isKeepAliveMarked("demo")).toBe(false);
		expect(workflowController.getState().mcpServers.find((s) => s.name === "demo")?.enabled).toBe(false);

		mcpManager.enable("demo");
		expect(mcpManager.isKeepAliveMarked("demo")).toBe(true);
		expect(workflowController.getState().mcpServers.find((s) => s.name === "demo")?.enabled).toBe(true);
	});

	it("repeated discover does not leak health intervals; shutdown clears interval", () => {
		const cwd = mkdtempSync(join(tmpdir(), "qi-mcp-hc-"));
		dirs.push(cwd);
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {} }), "utf-8");

		mcpManager.discover(cwd);
		expect(mcpManager.hasHealthCheckInterval()).toBe(true);
		mcpManager.discover(cwd);
		expect(mcpManager.hasHealthCheckInterval()).toBe(true);

		const manager = new McpServerManager();
		const lifecycle = new McpLifecycleManager(manager);
		lifecycle.startHealthChecks(60_000);
		expect(lifecycle.hasHealthCheckInterval()).toBe(true);
		lifecycle.startHealthChecks(60_000);
		expect(lifecycle.hasHealthCheckInterval()).toBe(true);
		void lifecycle.gracefulShutdown();
		expect(lifecycle.hasHealthCheckInterval()).toBe(false);

		mcpManager.shutdown();
		expect(mcpManager.hasHealthCheckInterval()).toBe(false);
	});
});

describe("qi-workflow rewind real git restore", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("checkpoint + restore changes file content back via vendor path", async () => {
		const root = mkdtempSync(join(tmpdir(), "qi-rewind-git-"));
		dirs.push(root);
		execFileSync("git", ["init"], { cwd: root });
		execFileSync("git", ["config", "user.email", "qi@test"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Qi Test"], { cwd: root });
		const file = join(root, "note.txt");
		writeFileSync(file, "v1\n", "utf-8");
		execFileSync("git", ["add", "note.txt"], { cwd: root });
		execFileSync("git", ["commit", "-m", "init"], { cwd: root });

		const cp = await createCheckpoint({
			root,
			id: "test-cp-1",
			sessionId: "s1",
			trigger: "tool",
			turnIndex: 0,
			description: "before edit",
		});
		expect(cp.id).toBe("test-cp-1");
		writeFileSync(file, "v2-mutated\n", "utf-8");
		expect(readFileSync(file, "utf-8")).toBe("v2-mutated\n");

		const loaded = await loadCheckpointFromRef(root, cp.id);
		expect(loaded).toBeTruthy();
		await restoreCheckpoint(root, loaded!);
		expect(readFileSync(file, "utf-8")).toBe("v1\n");

		const viaQi = await checkpointFiles({
			cwd: root,
			sessionId: "s1",
			trigger: "tool",
			toolName: "write",
			description: "qi path",
		});
		expect(viaQi.gitRef?.startsWith(`${REF_BASE}/`)).toBe(true);
	});
});

describe("qi-workflow todo / ask / subagents adapters", () => {
	afterEach(() => {
		workflowController.store.replaceState(createEmptyState("adapter-reset"), false);
	});

	it("todo add/start/done goes through vendor reducer and projects to Qi board", () => {
		workflowController.store.replaceState(createEmptyState("todo-session"), false);
		const added = workflowController.apply((s) => addTodoViaVendor(s, "Board task"));
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.value.id).toMatch(/^todo_\d+$/);
		expect(workflowController.getState().todos.some((t) => t.text === "Board task")).toBe(true);

		const vendorId = Number(added.value.id.replace("todo_", ""));
		const started = workflowController.apply((s) =>
			mutateTodoViaVendor(s, "update", { id: vendorId, status: "in_progress" }),
		);
		expect(started.ok).toBe(true);
		expect(workflowController.getState().todos.find((t) => t.id === added.value.id)?.status).toBe("in_progress");

		const done = workflowController.apply((s) =>
			mutateTodoViaVendor(s, "update", { id: vendorId, status: "completed" }),
		);
		expect(done.ok).toBe(true);
		expect(workflowController.getState().todos.find((t) => t.id === added.value.id)?.status).toBe("completed");
	});

	it("ask validates through vendor questionnaire validator before overlay", () => {
		const bad = validateAskQuestions([
			{
				prompt: "Pick?",
				header: "Pick",
				options: [
					{ label: "Other", description: "reserved" },
					{ label: "A", description: "ok" },
				],
			},
		]);
		expect(bad.ok).toBe(false);

		const good = validateAskQuestions([
			{
				prompt: "Pick?",
				header: "Pick",
				options: [
					{ label: "Alpha", description: "a" },
					{ label: "Beta", description: "b" },
				],
			},
		]);
		expect(good.ok).toBe(true);
	});
});

describe("qi-workflow subagent registration", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		workflowController.store.replaceState(createEmptyState("subagent-reset"), false);
	});

	it("registers subagent tool through vendor registerSubagents", async () => {
		harness = await createHarness({
			extensionFactories: builtInExtensions,
		});
		const extTools = harness.session.extensionRunner.getAllRegisteredTools();
		expect(extTools.some((t) => t.definition.name === "subagent")).toBe(true);
	});
});
