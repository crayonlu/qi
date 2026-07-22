import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import {
	addTodo,
	blockGoal,
	blockTodo,
	cancelTodo,
	completeGoal,
	completeTodo,
	markPlanReady,
	moveTodo,
	openQuestion,
	type PlanSections,
	type QuestionOption,
	removeTodo,
	startTodo,
	updatePlanSections,
} from "../domain/index.ts";
import { jobManager } from "../runtime/index.ts";
import { showQuestionOverlay } from "../ui/index.ts";
import { normalizePlanModeCompletion, PLAN_MODE_COMPLETE_TOOL_NAME } from "../vendor/plan/completion-tool.ts";

const DETAILS_HINT = "Open /todos or the dashboard for details.";

function textResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function failResult(error: string, details?: unknown) {
	return textResult(`Error: ${error}`, { error, ...((details as object) ?? {}) });
}

function shortId(id: string): string {
	const parts = id.split("_");
	return parts[parts.length - 1]?.slice(0, 8) ?? id.slice(0, 8);
}

function summarize(text: string, max = 120): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function registerQiWorkflowTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Mark the active goal completed with verifiable evidence. goalId is required and must match the current goal.",
		parameters: Type.Object({
			goalId: Type.String({ description: "Current goal id (required; rejects if stale)" }),
			evidence: Type.String({ description: "Completion evidence proving the objective is met" }),
		}),
		async execute(_toolCallId, params) {
			const result = workflowController.apply((state) => completeGoal(state, params.evidence, params.goalId));
			if (!result.ok) return failResult(result.error);
			return textResult(`Goal completed (${shortId(result.value.id)}). ${DETAILS_HINT}`, {
				action: "goal_complete",
				goalId: result.value.id,
				status: result.value.status,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("goal_complete ")) + theme.fg("muted", summarize(args.evidence, 60)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "success", summarize(text, 100)), 0, 0);
		},
	});

	pi.registerTool({
		name: "goal_blocked",
		label: "Goal Blocked",
		description: "Mark the active goal blocked with a reason. goalId is required and must match the current goal.",
		parameters: Type.Object({
			goalId: Type.String({ description: "Current goal id (required; rejects if stale)" }),
			reason: Type.String({ description: "Why the goal cannot proceed" }),
		}),
		async execute(_toolCallId, params) {
			const result = workflowController.apply((state) => blockGoal(state, params.reason, params.goalId));
			if (!result.ok) return failResult(result.error);
			return textResult(
				`Goal blocked (${shortId(result.value.id)}): ${summarize(params.reason, 80)}. ${DETAILS_HINT}`,
				{ action: "goal_blocked", goalId: result.value.id, status: result.value.status },
			);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("goal_blocked ")) + theme.fg("warning", summarize(args.reason, 60)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "warning", summarize(text, 100)), 0, 0);
		},
	});

	const TodoParams = Type.Object({
		action: StringEnum(["list", "add", "start", "block", "done", "cancel", "remove", "move"] as const, {
			description: "Todo action",
		}),
		text: Type.Optional(Type.String({ description: "Todo text (add)" })),
		id: Type.Optional(Type.String({ description: "Todo id (start/block/done/cancel/remove/move)" })),
		reason: Type.Optional(Type.String({ description: "Block reason (block)" })),
		verification: Type.Optional(Type.String({ description: "Done verification (done)" })),
		position: Type.Optional(Type.Number({ description: "New position index (move)" })),
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage session todos. Actions: list, add (text), start/block/done/cancel/remove (id), move (id, position).",
		parameters: TodoParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const todos = workflowController.getState().todos;
					if (todos.length === 0) return textResult(`No todos. ${DETAILS_HINT}`, { action: "list", count: 0 });
					const lines = todos
						.slice()
						.sort((a, b) => a.position - b.position)
						.map((t) => `[${t.status}] ${shortId(t.id)} ${t.text}`)
						.join("\n");
					return textResult(`${lines}\n${DETAILS_HINT}`, { action: "list", count: todos.length });
				}
				case "add": {
					if (!params.text) return failResult("text required for add");
					const result = workflowController.apply((state) => addTodo(state, params.text!));
					if (!result.ok) return failResult(result.error);
					return textResult(`Added todo ${shortId(result.value.id)}. ${DETAILS_HINT}`, {
						action: "add",
						id: result.value.id,
					});
				}
				case "start": {
					if (!params.id) return failResult("id required for start");
					const result = workflowController.apply((state) => startTodo(state, params.id!));
					if (!result.ok) return failResult(result.error);
					return textResult(`Started todo ${shortId(result.value.id)}. ${DETAILS_HINT}`, {
						action: "start",
						id: result.value.id,
					});
				}
				case "block": {
					if (!params.id) return failResult("id required for block");
					if (!params.reason) return failResult("reason required for block");
					const result = workflowController.apply((state) => blockTodo(state, params.id!, params.reason!));
					if (!result.ok) return failResult(result.error);
					return textResult(`Blocked todo ${shortId(result.value.id)}. ${DETAILS_HINT}`, {
						action: "block",
						id: result.value.id,
					});
				}
				case "done": {
					if (!params.id) return failResult("id required for done");
					const result = workflowController.apply((state) => completeTodo(state, params.id!, params.verification));
					if (!result.ok) return failResult(result.error);
					return textResult(`Completed todo ${shortId(result.value.id)}. ${DETAILS_HINT}`, {
						action: "done",
						id: result.value.id,
					});
				}
				case "cancel": {
					if (!params.id) return failResult("id required for cancel");
					const result = workflowController.apply((state) => cancelTodo(state, params.id!));
					if (!result.ok) return failResult(result.error);
					return textResult(`Cancelled todo ${shortId(result.value.id)}. ${DETAILS_HINT}`, {
						action: "cancel",
						id: result.value.id,
					});
				}
				case "remove": {
					if (!params.id) return failResult("id required for remove");
					const result = workflowController.apply((state) => removeTodo(state, params.id!));
					if (!result.ok) return failResult(result.error);
					return textResult(`Removed todo. ${DETAILS_HINT}`, { action: "remove", id: params.id });
				}
				case "move": {
					if (!params.id) return failResult("id required for move");
					if (params.position === undefined) return failResult("position required for move");
					const result = workflowController.apply((state) => moveTodo(state, params.id!, params.position!));
					if (!result.ok) return failResult(result.error);
					return textResult(
						`Moved todo ${shortId(result.value.id)} to position ${result.value.position}. ${DETAILS_HINT}`,
						{ action: "move", id: result.value.id, position: result.value.position },
					);
				}
				default:
					return failResult(`Unknown action: ${String((params as { action: string }).action)}`);
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${summarize(args.text, 40)}"`)}`;
			if (args.id) text += ` ${theme.fg("accent", shortId(args.id))}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "success", summarize(text.split("\n")[0] ?? text, 100)), 0, 0);
		},
	});

	const sectionKeys = [
		"discoveries",
		"assumptions",
		"decisions",
		"steps",
		"verification",
		"unresolvedQuestions",
	] as const;

	pi.registerTool({
		name: "plan_update",
		label: "Plan Update",
		description:
			"Patch plan sections (discoveries, assumptions, decisions, steps, verification, unresolvedQuestions). Resets plan to draft. Optional revision for optimistic concurrency.",
		parameters: Type.Object({
			discoveries: Type.Optional(Type.Array(Type.String())),
			assumptions: Type.Optional(Type.Array(Type.String())),
			decisions: Type.Optional(Type.Array(Type.String())),
			steps: Type.Optional(Type.Array(Type.String())),
			verification: Type.Optional(Type.Array(Type.String())),
			unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
			revision: Type.Optional(Type.Number({ description: "Expected plan revision" })),
		}),
		async execute(_toolCallId, params) {
			const patch: Partial<PlanSections> = {};
			for (const key of sectionKeys) {
				if (params[key] !== undefined) patch[key] = params[key];
			}
			if (Object.keys(patch).length === 0) return failResult("At least one section patch is required");
			const result = workflowController.apply((state) => updatePlanSections(state, patch, params.revision));
			if (!result.ok) return failResult(result.error);
			const changed = Object.keys(patch).join(", ");
			return textResult(`Plan updated (rev ${result.value.revision}, ${changed}). Status: draft. ${DETAILS_HINT}`, {
				action: "plan_update",
				revision: result.value.revision,
				status: result.value.status,
			});
		},
		renderCall(args, theme) {
			const keys = sectionKeys.filter((k) => args[k] !== undefined);
			return new Text(
				theme.fg("toolTitle", theme.bold("plan_update ")) + theme.fg("muted", keys.join(", ") || "…"),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "success", summarize(text, 100)), 0, 0);
		},
	});

	pi.registerTool({
		name: PLAN_MODE_COMPLETE_TOOL_NAME,
		label: "Plan Mode Complete",
		description: "Mark the draft plan ready with a decision-ready Markdown plan body (typed markPlanReady).",
		parameters: Type.Object({
			plan: Type.String({ description: "Complete decision-ready implementation plan in Markdown" }),
			revision: Type.Optional(Type.Number({ description: "Expected plan revision" })),
		}),
		async execute(_toolCallId, params) {
			const normalized = normalizePlanModeCompletion({ plan: params.plan });
			if (!normalized.ok) return failResult(normalized.error);
			// Persist plan body into steps when empty so ready conversion has content.
			const current = workflowController.getState().plan;
			if (current && current.sections.steps.length === 0) {
				const patched = workflowController.apply((state) =>
					updatePlanSections(state, { steps: [normalized.plan] }, params.revision),
				);
				if (!patched.ok) return failResult(patched.error);
			}
			const result = workflowController.apply((state) => markPlanReady(state, params.revision));
			if (!result.ok) return failResult(result.error);
			return textResult(`Plan ready (rev ${result.value.revision}). ${DETAILS_HINT}`, {
				action: PLAN_MODE_COMPLETE_TOOL_NAME,
				revision: result.value.revision,
				status: result.value.status,
				plan: normalized.plan,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold(`${PLAN_MODE_COMPLETE_TOOL_NAME} `)) +
					theme.fg("muted", summarize(args.plan, 50)),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "success", summarize(text, 100)), 0, 0);
		},
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description:
			"Ask the user one or more structured multiple-choice questions (blocking). Use only for required decisions that cannot be inferred from the workspace.",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					prompt: Type.String({ description: "Question prompt" }),
					header: Type.Optional(Type.String()),
					options: Type.Array(
						Type.Object({
							label: Type.String(),
							description: Type.Optional(Type.String()),
						}),
						{ minItems: 2 },
					),
					multiSelect: Type.Optional(Type.Boolean()),
					allowFreeInput: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 1 },
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return failResult("ask_user_question requires interactive UI");
			}

			const answers: Array<{ prompt: string; answerSummary?: string; cancelled?: boolean }> = [];

			for (const q of params.questions) {
				const options: QuestionOption[] = q.options.map((o) => ({
					label: o.label,
					description: o.description,
				}));
				const opened = workflowController.apply((state) =>
					openQuestion(state, q.prompt, options, {
						header: q.header,
						multiSelect: q.multiSelect,
						allowFreeInput: q.allowFreeInput,
					}),
				);
				if (!opened.ok) return failResult(opened.error, { answers });

				const overlay = await showQuestionOverlay(ctx, workflowController);
				if (overlay.action === "cancelled") {
					answers.push({ prompt: q.prompt, cancelled: true });
					return textResult(`Question cancelled: ${summarize(q.prompt, 60)}. ${DETAILS_HINT}`, {
						action: "ask_user_question",
						answers,
						cancelled: true,
					});
				}
				answers.push({ prompt: q.prompt, answerSummary: overlay.answerSummary });
			}

			const summary = answers
				.map((a) => a.answerSummary)
				.filter(Boolean)
				.join(" | ");
			return textResult(`Answered: ${summarize(summary, 160)}. ${DETAILS_HINT}`, {
				action: "ask_user_question",
				answers,
			});
		},
		renderCall(args, theme) {
			const n = args.questions?.length ?? 0;
			const first = args.questions?.[0]?.prompt;
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_user_question ")) +
					theme.fg("muted", `${n}q`) +
					(first ? theme.fg("dim", ` ${summarize(first, 40)}`) : ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "accent", summarize(text, 100)), 0, 0);
		},
	});

	pi.registerTool({
		name: "process",
		label: "Process",
		description:
			"Manage background jobs: start, status, logs, wait, cancel. Prefer short status; use dashboard for full logs.",
		parameters: Type.Object({
			action: StringEnum(["start", "status", "logs", "wait", "cancel"] as const),
			name: Type.Optional(Type.String({ description: "Job name (start)" })),
			command: Type.Optional(Type.String({ description: "Shell command (start)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (start)" })),
			id: Type.Optional(Type.String({ description: "Job id (status/logs/wait/cancel)" })),
			tail: Type.Optional(Type.Number({ description: "Log tail lines (logs)" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout ms (wait); 0 = no timeout" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "start": {
					if (!params.name || !params.command) return failResult("name and command required for start");
					try {
						const job = jobManager.start(params.name, params.command, params.cwd ?? ctx.cwd);
						return textResult(`Started job ${shortId(job.id)} (${job.name}, ${job.status}). ${DETAILS_HINT}`, {
							action: "start",
							id: job.id,
							status: job.status,
						});
					} catch (err) {
						return failResult(err instanceof Error ? err.message : String(err));
					}
				}
				case "status": {
					if (!params.id) return failResult("id required for status");
					const job = jobManager.status(params.id);
					if (!job) return failResult(`Job not found: ${params.id}`);
					return textResult(
						`Job ${shortId(job.id)}: ${job.status}${job.exitCode !== undefined ? ` exit=${job.exitCode}` : ""}. ${DETAILS_HINT}`,
						{ action: "status", id: job.id, status: job.status, exitCode: job.exitCode },
					);
				}
				case "logs": {
					if (!params.id) return failResult("id required for logs");
					const job = jobManager.status(params.id);
					if (!job) return failResult(`Job not found: ${params.id}`);
					const logs = jobManager.logs(params.id, params.tail);
					const preview = summarize(logs.replace(/\n/g, " "), 160) || "(no output yet)";
					return textResult(`Job ${shortId(job.id)} logs: ${preview}. ${DETAILS_HINT}`, {
						action: "logs",
						id: job.id,
						bytes: job.outputBytes,
					});
				}
				case "wait": {
					if (!params.id) return failResult("id required for wait");
					try {
						const job = await jobManager.wait(params.id, { timeoutMs: params.timeoutMs });
						return textResult(
							`Job ${shortId(job.id)} finished: ${job.status}${job.exitCode !== undefined ? ` exit=${job.exitCode}` : ""}. ${DETAILS_HINT}`,
							{ action: "wait", id: job.id, status: job.status, exitCode: job.exitCode },
						);
					} catch (err) {
						return failResult(err instanceof Error ? err.message : String(err));
					}
				}
				case "cancel": {
					if (!params.id) return failResult("id required for cancel");
					try {
						const job = jobManager.cancel(params.id);
						return textResult(`Cancelling job ${shortId(job.id)} (${job.status}). ${DETAILS_HINT}`, {
							action: "cancel",
							id: job.id,
							status: job.status,
						});
					} catch (err) {
						return failResult(err instanceof Error ? err.message : String(err));
					}
				}
				default:
					return failResult(`Unknown action: ${String((params as { action: string }).action)}`);
			}
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("process ")) + theme.fg("muted", args.action);
			if (args.name) text += ` ${theme.fg("accent", args.name)}`;
			if (args.id) text += ` ${theme.fg("dim", shortId(args.id))}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			const err = text.startsWith("Error:");
			return new Text(theme.fg(err ? "error" : "muted", summarize(text, 100)), 0, 0);
		},
	});
}
