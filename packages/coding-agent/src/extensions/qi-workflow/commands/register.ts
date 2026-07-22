import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../../core/extensions/types.ts";
import {
	addTodoViaVendor,
	mutateTodoViaVendor,
	pauseGoalViaVendor,
	resolveVendorTodoId,
	resumeGoalViaVendor,
	setGoalViaVendor,
} from "../adapters/index.ts";
import { workflowController } from "../controller.ts";
import {
	attachTask,
	blockTodo,
	cancelTask,
	clearGoal,
	createWorkflow,
	discardPlan,
	editGoal,
	editPlanGoal,
	executePlanToTodos,
	executePlanToWorkflow,
	markPlanReady,
	startPlan,
	type WorkflowMode,
} from "../domain/index.ts";
import {
	applyLastCleanupReport,
	dryRunCleanup,
	getWorkflowPromise,
	listRewindCheckpoints,
	mcpManager,
	requestCancelWorkflow,
	restoreRewind,
	runBtwSideTurn,
	runExistingWorkflow,
	runWorkflow,
} from "../runtime/index.ts";
import {
	openDashboard,
	showBtwOverlay,
	showCleanupPanel,
	showMcpPanel,
	showQuestionOverlay,
	showRewindPanel,
} from "../ui/index.ts";

function notifyResult(ctx: ExtensionCommandContext, ok: boolean, message: string): void {
	ctx.ui.notify(message, ok ? "info" : "error");
}

function shortId(id: string): string {
	const parts = id.split("_");
	return parts[parts.length - 1]?.slice(0, 8) ?? id.slice(0, 8);
}

function completions(prefix: string, options: string[]): AutocompleteItem[] | null {
	const filtered = options.filter((o) => o.startsWith(prefix));
	return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
}

function todoIdCompletions(prefix: string): AutocompleteItem[] | null {
	const ids = workflowController.getState().todos.map((todo) => todo.id);
	return completions(prefix, ids);
}

/** Second-level completions: actions, then todo ids where applicable. */
function todoArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const actions = ["add", "start", "block", "done", "cancel", "remove", "move"];
	const spaceIndex = prefix.indexOf(" ");
	if (spaceIndex === -1) {
		return completions(prefix.trim(), actions);
	}
	const action = prefix.slice(0, spaceIndex).trim();
	if (!actions.includes(action) || action === "add") {
		return null;
	}
	const rest = prefix.slice(spaceIndex + 1);
	if (action === "move") {
		const moveSpace = rest.indexOf(" ");
		if (moveSpace === -1) {
			return todoIdCompletions(rest.trimStart());
		}
		// Position hints after id
		return completions(rest.slice(moveSpace + 1).trimStart(), ["0", "1", "2", "3", "4", "5"]);
	}
	// id-taking actions; allow optional trailing text without further completions
	const idSpace = rest.indexOf(" ");
	if (idSpace === -1) {
		return todoIdCompletions(rest.trimStart());
	}
	return null;
}

function firstToken(args: string): { cmd: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { cmd: "", rest: "" };
	const m = /^(\S+)(?:\s+(.*))?$/s.exec(trimmed);
	return { cmd: m?.[1] ?? "", rest: (m?.[2] ?? "").trim() };
}

function requireUi(ctx: ExtensionCommandContext, command: string): boolean {
	if (ctx.hasUI && ctx.mode === "tui") return true;
	ctx.ui.notify(`/${command} requires interactive mode`, "warning");
	return false;
}

function isHeadless(ctx: ExtensionCommandContext): boolean {
	return !ctx.hasUI || ctx.mode === "print" || ctx.mode === "json";
}

function formatCleanupReport(report: {
	summary: string;
	dryRun: boolean;
	applied: boolean;
	categories: Array<{ label: string; count: number; bytes: number; paths: string[] }>;
}): string {
	const lines = [report.summary, `dryRun=${report.dryRun} applied=${report.applied}`];
	for (const cat of report.categories) {
		lines.push(`- ${cat.label}: ${cat.count} items, ${cat.bytes} bytes`);
		for (const path of cat.paths.slice(0, 5)) lines.push(`    ${path}`);
		if (cat.paths.length > 5) lines.push(`    …${cat.paths.length - 5} more`);
	}
	return lines.join("\n");
}

function goalStatusText(): string {
	const goal = workflowController.getState().goal;
	if (!goal) return "No active goal. Use /goal <objective> to set one.";
	const bits = [`Goal ${shortId(goal.id)} [${goal.status}]`, goal.objective];
	if (goal.blockReason) bits.push(`Blocked: ${goal.blockReason}`);
	if (goal.completionEvidence) bits.push(`Evidence: ${goal.completionEvidence}`);
	const todos = workflowController.getState().todos.filter((t) => t.goalId === goal.id);
	if (todos.length) {
		const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
		bits.push(`Todos: ${open} open / ${todos.length} total`);
	}
	return bits.join("\n");
}

/**
 * createWorkflow → executePlanToWorkflow → runExistingWorkflow (no duplicate create).
 */
async function executeReadyPlanToWorkflow(ctx: ExtensionCommandContext, mode: WorkflowMode): Promise<void> {
	const plan = workflowController.getState().plan;
	if (!plan || plan.status !== "ready") {
		notifyResult(ctx, false, "Plan must be ready to execute.");
		return;
	}
	const steps = plan.sections.steps;
	const taskGoals = steps.length > 0 ? steps : [plan.goal];

	const created = workflowController.apply((state) => createWorkflow(state, plan.goal, mode, false, taskGoals));
	if (!created.ok) {
		notifyResult(ctx, false, created.error);
		return;
	}

	const linked = workflowController.apply((state) => executePlanToWorkflow(state, created.value));
	if (!linked.ok) {
		notifyResult(ctx, false, linked.error);
		return;
	}

	try {
		const ran = await runExistingWorkflow(created.value.id, {
			cwd: ctx.cwd,
			model: ctx.model,
			background: false,
		});
		notifyResult(ctx, true, ran.resultSummary ?? `Workflow ${shortId(ran.workflow.id)} finished.`);
	} catch (err) {
		notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
	}
}

async function handlePlanExecute(ctx: ExtensionCommandContext): Promise<void> {
	const plan = workflowController.getState().plan;
	if (!plan || plan.status !== "ready") {
		notifyResult(ctx, false, "Plan must be ready to execute. Use /plan ready first.");
		return;
	}
	if (!ctx.hasUI) {
		notifyResult(ctx, false, "/plan execute requires UI to choose Create Todos vs Create Workflow");
		return;
	}

	const choice = await ctx.ui.select("Execute plan", ["Create Todos", "Create Workflow", "Cancel"]);
	if (!choice || choice === "Cancel") return;

	if (choice === "Create Todos") {
		const result = workflowController.apply((state) => executePlanToTodos(state));
		notifyResult(
			ctx,
			result.ok,
			result.ok ? `Created ${result.value.todos.length} todo(s) from plan.` : result.error,
		);
		return;
	}

	const modeChoice = await ctx.ui.select("Workflow mode", ["chain", "parallel", "single", "Cancel"]);
	if (!modeChoice || modeChoice === "Cancel") return;
	await executeReadyPlanToWorkflow(ctx, modeChoice as WorkflowMode);
}

export function registerQiWorkflowCommands(pi: ExtensionAPI): void {
	pi.registerCommand("goal", {
		description: "Show, set, pause, resume, clear, or edit the session goal",
		category: "start",
		argumentHint: "<objective> | edit <objective> | pause | resume | clear",
		getArgumentCompletions: (prefix) => completions(prefix, ["pause", "resume", "clear", "edit"]),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(goalStatusText(), "info");
				return;
			}
			const { cmd, rest } = firstToken(trimmed);
			if (cmd === "pause") {
				const r = workflowController.apply((s) => pauseGoalViaVendor(s));
				notifyResult(ctx, r.ok, r.ok ? "Goal paused." : r.error);
				return;
			}
			if (cmd === "resume") {
				const r = workflowController.apply((s) => resumeGoalViaVendor(s));
				notifyResult(ctx, r.ok, r.ok ? "Goal resumed." : r.error);
				return;
			}
			if (cmd === "clear") {
				const r = workflowController.apply((s) => clearGoal(s));
				notifyResult(ctx, r.ok, r.ok ? "Goal cleared." : r.error);
				return;
			}
			if (cmd === "edit") {
				if (!rest) {
					notifyResult(ctx, false, "Usage: /goal edit <objective>");
					return;
				}
				const r = workflowController.apply((s) => editGoal(s, rest));
				notifyResult(ctx, r.ok, r.ok ? "Goal updated." : r.error);
				return;
			}
			const r = workflowController.apply((s) => setGoalViaVendor(s, trimmed));
			notifyResult(ctx, r.ok, r.ok ? `Goal set: ${r.value.objective}` : r.error);
		},
	});

	pi.registerCommand("todos", {
		description: "Open the Qi dashboard Todo tab",
		category: "work",
		handler: async (_args, ctx) => {
			if (!requireUi(ctx, "todos")) return;
			await openDashboard(ctx, workflowController, "todo");
		},
	});

	pi.registerCommand("todo", {
		description: "Manage todos: add|start|block|done|cancel|remove|move",
		category: "work",
		argumentHint: "add <text> | start <id> | block <id> <reason> | done <id> [verification] | …",
		getArgumentCompletions: todoArgumentCompletions,
		handler: async (args, ctx) => {
			const { cmd, rest } = firstToken(args);
			if (!cmd) {
				notifyResult(ctx, false, "Usage: /todo add|start|block|done|cancel|remove|move …");
				return;
			}
			switch (cmd) {
				case "add": {
					if (!rest) {
						notifyResult(ctx, false, "Usage: /todo add <text>");
						return;
					}
					const r = workflowController.apply((s) => addTodoViaVendor(s, rest));
					notifyResult(ctx, r.ok, r.ok ? `Added ${shortId(r.value.id)}` : r.error);
					return;
				}
				case "start": {
					if (!rest) {
						notifyResult(ctx, false, "Usage: /todo start <id>");
						return;
					}
					const vendorId = resolveVendorTodoId(rest);
					if (vendorId === undefined) {
						notifyResult(ctx, false, `Unknown todo id: ${rest}`);
						return;
					}
					const r = workflowController.apply((s) =>
						mutateTodoViaVendor(s, "update", { id: vendorId, status: "in_progress" }),
					);
					notifyResult(ctx, r.ok, r.ok ? `Started ${shortId(rest)}` : r.error);
					return;
				}
				case "block": {
					const { cmd: id, rest: reason } = firstToken(rest);
					if (!id || !reason) {
						notifyResult(ctx, false, "Usage: /todo block <id> <reason>");
						return;
					}
					// Vendor TaskStatus has no blocked; keep Qi projection field for board.
					const r = workflowController.apply((s) => blockTodo(s, id, reason));
					notifyResult(ctx, r.ok, r.ok ? `Blocked ${shortId(r.value.id)}` : r.error);
					return;
				}
				case "done": {
					const { cmd: id, rest: verification } = firstToken(rest);
					if (!id) {
						notifyResult(ctx, false, "Usage: /todo done <id> [verification]");
						return;
					}
					const vendorId = resolveVendorTodoId(id);
					if (vendorId === undefined) {
						notifyResult(ctx, false, `Unknown todo id: ${id}`);
						return;
					}
					const r = workflowController.apply((s) =>
						mutateTodoViaVendor(s, "update", {
							id: vendorId,
							status: "completed",
							metadata: verification ? { verification } : undefined,
						}),
					);
					notifyResult(ctx, r.ok, r.ok ? `Done ${shortId(id)}` : r.error);
					return;
				}
				case "cancel":
				case "remove": {
					if (!rest) {
						notifyResult(ctx, false, `Usage: /todo ${cmd} <id>`);
						return;
					}
					const vendorId = resolveVendorTodoId(rest);
					if (vendorId === undefined) {
						notifyResult(ctx, false, `Unknown todo id: ${rest}`);
						return;
					}
					const r = workflowController.apply((s) => mutateTodoViaVendor(s, "delete", { id: vendorId }));
					notifyResult(
						ctx,
						r.ok,
						r.ok ? (cmd === "cancel" ? `Cancelled ${shortId(rest)}` : "Removed todo.") : r.error,
					);
					return;
				}
				case "move": {
					notifyResult(ctx, false, "Use the todo tool or dashboard to reorder; vendor store is id-based.");
					return;
				}
				default:
					notifyResult(ctx, false, `Unknown /todo action: ${cmd}`);
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Plan mode: open dashboard, start, edit, ready, execute, discard",
		category: "start",
		argumentHint: "<goal> | edit <goal> | ready | execute | discard",
		getArgumentCompletions: (prefix) => completions(prefix, ["edit", "ready", "execute", "discard"]),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				if (!requireUi(ctx, "plan")) return;
				await openDashboard(ctx, workflowController, "plan");
				return;
			}
			const { cmd, rest } = firstToken(trimmed);
			if (cmd === "edit") {
				if (!rest) {
					notifyResult(ctx, false, "Usage: /plan edit <goal>");
					return;
				}
				const r = workflowController.apply((s) => editPlanGoal(s, rest));
				notifyResult(ctx, r.ok, r.ok ? "Plan goal updated." : r.error);
				return;
			}
			if (cmd === "ready") {
				const r = workflowController.apply((s) => markPlanReady(s));
				notifyResult(ctx, r.ok, r.ok ? "Plan marked ready." : r.error);
				return;
			}
			if (cmd === "execute") {
				await handlePlanExecute(ctx);
				return;
			}
			if (cmd === "discard") {
				const r = workflowController.apply((s) => discardPlan(s));
				notifyResult(ctx, r.ok, r.ok ? "Plan discarded." : r.error);
				return;
			}
			const r = workflowController.apply((s) => startPlan(s, trimmed));
			notifyResult(ctx, r.ok, r.ok ? `Plan started: ${r.value.goal}` : r.error);
		},
	});

	pi.registerCommand("workflow", {
		description: "Run, background, status, await, or cancel workflows",
		category: "start",
		argumentHint: "run <goal> | background <goal> | status <id> | await <id> | cancel <id>",
		getArgumentCompletions: (prefix) => completions(prefix, ["run", "background", "status", "await", "cancel"]),
		handler: async (args, ctx) => {
			const { cmd, rest } = firstToken(args);
			if (!cmd) {
				notifyResult(ctx, false, "Usage: /workflow run|background|status|await|cancel …");
				return;
			}
			if (cmd === "run" || cmd === "background") {
				if (!rest) {
					notifyResult(ctx, false, `Usage: /workflow ${cmd} <goal>`);
					return;
				}
				try {
					const result = await runWorkflow({
						goal: rest,
						mode: "single",
						background: cmd === "background",
						cwd: ctx.cwd,
						model: ctx.model,
					});
					if (cmd === "background") {
						notifyResult(ctx, true, `Background workflow ${shortId(result.workflow.id)} started.`);
					} else {
						notifyResult(ctx, true, result.resultSummary ?? `Workflow ${shortId(result.workflow.id)} finished.`);
					}
				} catch (err) {
					notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
				}
				return;
			}
			if (cmd === "status") {
				if (!rest) {
					notifyResult(ctx, false, "Usage: /workflow status <id>");
					return;
				}
				const wf = workflowController.getState().workflows.find((w) => w.id === rest || w.id.endsWith(rest));
				if (!wf) {
					notifyResult(ctx, false, `Workflow not found: ${rest}`);
					return;
				}
				ctx.ui.notify(
					`Workflow ${shortId(wf.id)} [${wf.status}] ${wf.mode}${wf.background ? " bg" : ""}\n${wf.summary}`,
					"info",
				);
				return;
			}
			if (cmd === "await") {
				if (!rest) {
					notifyResult(ctx, false, "Usage: /workflow await <id>");
					return;
				}
				const promise = getWorkflowPromise(rest);
				const wf = workflowController.getState().workflows.find((w) => w.id === rest || w.id.endsWith(rest));
				if (!promise) {
					if (wf && (wf.status === "completed" || wf.status === "failed" || wf.status === "cancelled")) {
						ctx.ui.notify(wf.resultSummary ?? `Workflow ${shortId(wf.id)}: ${wf.status}`, "info");
						return;
					}
					notifyResult(ctx, false, `No in-flight workflow promise for ${rest}`);
					return;
				}
				try {
					const summary = await promise;
					ctx.ui.notify(summary, "info");
				} catch (err) {
					notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
				}
				return;
			}
			if (cmd === "cancel") {
				if (!rest) {
					notifyResult(ctx, false, "Usage: /workflow cancel <id>");
					return;
				}
				try {
					const wf = requestCancelWorkflow(rest);
					notifyResult(ctx, true, `Cancelled workflow ${shortId(wf.id)}`);
				} catch (err) {
					notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
				}
				return;
			}
			notifyResult(ctx, false, `Unknown /workflow action: ${cmd}`);
		},
	});

	pi.registerCommand("tasks", {
		description: "Open the Qi dashboard Task tab",
		category: "work",
		handler: async (_args, ctx) => {
			if (!requireUi(ctx, "tasks")) return;
			await openDashboard(ctx, workflowController, "task");
		},
	});

	pi.registerCommand("task", {
		description: "Task status, cancel, or attach",
		category: "work",
		argumentHint: "status <id> | cancel <id> | attach <id>",
		getArgumentCompletions: (prefix) => {
			const actions = ["status", "cancel", "attach"];
			const spaceIndex = prefix.indexOf(" ");
			if (spaceIndex === -1) return completions(prefix.trim(), actions);
			const action = prefix.slice(0, spaceIndex).trim();
			if (!actions.includes(action)) return null;
			const ids = workflowController.getState().tasks.map((task) => task.id);
			return completions(prefix.slice(spaceIndex + 1).trimStart(), ids);
		},
		handler: async (args, ctx) => {
			const { cmd, rest } = firstToken(args);
			if (!cmd || !rest) {
				notifyResult(ctx, false, "Usage: /task status|cancel|attach <id>");
				return;
			}
			const task = workflowController.getState().tasks.find((t) => t.id === rest || t.id.endsWith(rest));
			if (cmd === "status") {
				if (!task) {
					notifyResult(ctx, false, `Task not found: ${rest}`);
					return;
				}
				ctx.ui.notify(
					`Task ${shortId(task.id)} [${task.status}]\n${task.goal}${task.resultSummary ? `\n${task.resultSummary}` : ""}${task.error ? `\nError: ${task.error}` : ""}`,
					"info",
				);
				return;
			}
			if (cmd === "cancel") {
				const r = workflowController.apply((s) => cancelTask(s, rest));
				notifyResult(ctx, r.ok, r.ok ? `Cancelled task ${shortId(r.value.id)}` : r.error);
				return;
			}
			if (cmd === "attach") {
				const r = workflowController.apply((s) => attachTask(s, rest));
				if (!r.ok) {
					notifyResult(ctx, false, r.error);
					return;
				}
				const summary = r.value.resultSummary ?? r.value.summary;
				ctx.ui.notify(`Attached task ${shortId(r.value.id)}: ${summary}`, "info");
				return;
			}
			notifyResult(ctx, false, `Unknown /task action: ${cmd}`);
		},
	});

	pi.registerCommand("jobs", {
		description: "Open the Qi dashboard Job tab",
		category: "work",
		handler: async (_args, ctx) => {
			if (!requireUi(ctx, "jobs")) return;
			await openDashboard(ctx, workflowController, "job");
		},
	});

	pi.registerCommand("ask", {
		description: "Show the pending structured question overlay",
		category: "work",
		handler: async (_args, ctx) => {
			const question = workflowController.getState().question;
			if (!question || question.status !== "open") {
				ctx.ui.notify("No pending structured question.", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Pending question: ${question.prompt}`, "info");
				return;
			}
			const result = await showQuestionOverlay(ctx, workflowController);
			if (result.action === "answered") {
				ctx.ui.notify(`Answered: ${result.answerSummary}`, "info");
			} else {
				ctx.ui.notify("Question cancelled.", "info");
			}
		},
	});

	pi.registerCommand("btw", {
		description: "Ask a side question without writing into the main transcript",
		category: "work",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				notifyResult(ctx, false, "Usage: /btw <question>");
				return;
			}
			if (workflowController.getState().question?.status === "open") {
				ctx.ui.notify("Structured question has priority over /btw", "warning");
				return;
			}
			try {
				ctx.ui.notify("Running /btw side turn…", "info");
				await runBtwSideTurn(question, { cwd: ctx.cwd, model: ctx.model, signal: ctx.signal, ctx });
				if (ctx.hasUI && ctx.mode === "tui") {
					await showBtwOverlay(ctx, workflowController);
				} else {
					const answer = workflowController.getState().btw?.answer;
					ctx.ui.notify(answer ? `btw: ${answer.slice(0, 200)}` : "btw finished.", "info");
				}
			} catch (err) {
				notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
			}
		},
	});

	pi.registerCommand("mcp", {
		description: "Discover and manage MCP servers",
		category: "integrations",
		argumentHint: "inspect | enable <server> | disable <server> | reconnect <server> | auth <server>",
		getArgumentCompletions: (prefix) => {
			const actions = ["inspect", "enable", "disable", "reconnect", "auth"];
			const trimmed = prefix.trim();
			const spaceIndex = prefix.indexOf(" ");
			if (spaceIndex === -1) {
				return completions(trimmed, actions);
			}
			const action = prefix.slice(0, spaceIndex).trim();
			if (!actions.includes(action)) {
				return null;
			}
			const serverPrefix = prefix.slice(spaceIndex + 1).trimStart();
			const servers = mcpManager.list().map((server) => server.name);
			return completions(serverPrefix, servers);
		},
		handler: async (args, ctx) => {
			mcpManager.discover(ctx.cwd);
			const { cmd, rest } = firstToken(args);
			if (cmd === "inspect" || cmd === "enable" || cmd === "disable" || cmd === "reconnect" || cmd === "auth") {
				if (!rest) {
					notifyResult(ctx, false, `Usage: /mcp ${cmd} <server>`);
					return;
				}
				if (cmd === "enable") {
					mcpManager.enable(rest);
					notifyResult(ctx, true, `Enabled MCP server ${rest}`);
					return;
				}
				if (cmd === "disable") {
					mcpManager.disable(rest);
					notifyResult(ctx, true, `Disabled MCP server ${rest}`);
					return;
				}
				if (cmd === "reconnect") {
					try {
						await mcpManager.reconnect(rest, ctx.cwd);
						notifyResult(ctx, true, `Reconnected MCP server ${rest}`);
					} catch (err) {
						notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
					}
					return;
				}
				if (cmd === "auth") {
					try {
						const result = await mcpManager.auth(rest, ctx.cwd);
						notifyResult(ctx, result.ok, result.message);
					} catch (err) {
						notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
					}
					return;
				}
				const info = mcpManager.inspect(rest);
				if (!info) {
					notifyResult(ctx, false, `Server not found: ${rest}`);
					return;
				}
				const tools = info.tools.length ? info.tools.join(", ") : "(no tools)";
				ctx.ui.notify(
					[
						`Name: ${info.server.name}`,
						`Status: ${info.server.status}`,
						`Transport: ${info.server.transport}`,
						`Source: ${info.server.sourcePath ?? "(none)"}`,
						`Tools (${info.tools.length}): ${tools}`,
						info.server.error ? `Error: ${info.server.error}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
					"info",
				);
				return;
			}
			if (!requireUi(ctx, "mcp")) {
				const servers = mcpManager.list();
				ctx.ui.notify(
					servers.length ? servers.map((s) => `${s.name}: ${s.status}`).join("\n") : "No MCP servers discovered.",
					"info",
				);
				return;
			}
			await showMcpPanel(ctx, workflowController, {
				enable: async (name) => {
					mcpManager.enable(name);
				},
				disable: async (name) => {
					mcpManager.disable(name);
				},
				reconnect: async (name) => {
					await mcpManager.reconnect(name, ctx.cwd);
				},
				inspect: async (name) => {
					const info = mcpManager.inspect(name);
					if (!info) return `Server not found: ${name}`;
					const tools = info.tools.length ? info.tools.join(", ") : "(no tools)";
					return [
						`Name: ${info.server.name}`,
						`Status: ${info.server.status}`,
						`Transport: ${info.server.transport}`,
						`Source: ${info.server.sourcePath ?? "(none)"}`,
						`Tools (${info.tools.length}): ${tools}`,
						info.server.error ? `Error: ${info.server.error}` : undefined,
					]
						.filter(Boolean)
						.join("\n");
				},
			});
		},
	});

	pi.registerCommand("rewind", {
		description: "Open the rewind / restore panel",
		category: "session",
		hidden: true,
		handler: async (_args, ctx) => {
			if (!requireUi(ctx, "rewind")) return;
			const checkpoints = listRewindCheckpoints();
			if (checkpoints.length === 0) {
				ctx.ui.notify("No rewind checkpoints yet. Restore will create one when confirmed.", "info");
			}
			await showRewindPanel(ctx, workflowController, {
				restore: async (checkpointId, scope) => {
					const cp = workflowController
						.getState()
						.rewindCheckpoints.find((c) => c.id === checkpointId || c.id.endsWith(checkpointId));
					await restoreRewind(ctx, {
						confirmed: true,
						scope,
						entryId: cp?.entryId,
						gitRef: cp?.gitRef,
						label: cp?.label ?? `restore:${scope}`,
						cwd: ctx.cwd,
					});
				},
			});
		},
	});

	pi.registerCommand("cleanup", {
		description: "Dry-run cleanup report; use --apply in headless to delete",
		category: "session",
		hidden: true,
		getArgumentCompletions: (prefix) => completions(prefix, ["--apply", "apply"]),
		handler: async (args, ctx) => {
			const wantApply = /(?:^|\s)(--apply|apply)(?:\s|$)/i.test(args);
			const opts = { currentSessionFile: ctx.sessionManager.getSessionFile() };
			try {
				const report = await dryRunCleanup(opts);
				if (isHeadless(ctx)) {
					const text = formatCleanupReport(report);
					console.log(text);
					ctx.ui.notify(report.summary, "info");
					if (wantApply) {
						const applied = await applyLastCleanupReport(opts);
						console.log(formatCleanupReport(applied));
						ctx.ui.notify(applied.summary, "info");
					}
					return;
				}
				await showCleanupPanel(ctx, workflowController, {
					dryRun: async () => {
						const r = await dryRunCleanup(opts);
						return r.categories;
					},
					apply: async () => {
						await applyLastCleanupReport(opts);
					},
				});
			} catch (err) {
				notifyResult(ctx, false, err instanceof Error ? err.message : String(err));
			}
		},
	});
}
