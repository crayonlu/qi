import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import {
	blockTodoViaVendor,
	buildAskEnvelope,
	clearTodosViaVendor,
	listTodosViaVendor,
	mapOverlayToAnswer,
	mutateTodoViaVendor,
	normalizePlanBody,
	PLAN_MODE_COMPLETE_TOOL_NAME,
	resolveVendorTodoId,
	validateAskQuestions,
} from "../adapters/index.ts";
import { workflowController } from "../controller.ts";
import {
	markPlanReady,
	openQuestion,
	type PlanSections,
	type QuestionOption,
	updatePlanSections,
} from "../domain/index.ts";
import { jobManager } from "../runtime/index.ts";
import { showQuestionOverlay } from "../ui/index.ts";
import type { QuestionAnswer } from "../vendor/ask/tool/types.ts";
import { planModeCompleted } from "../vendor/plan/completion-tool.ts";

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
	// goal_complete / goal_blocked are registered by attachGoalLifecycle (mature pi-goal tools).

	const TodoParams = Type.Object({
		action: StringEnum(
			["list", "add", "get", "update", "start", "block", "done", "cancel", "remove", "clear", "move"] as const,
			{ description: "Todo action" },
		),
		text: Type.Optional(Type.String({ description: "Todo subject (add/update)" })),
		description: Type.Optional(Type.String({ description: "Longer description (add/update)" })),
		owner: Type.Optional(Type.String({ description: "Owner label (add/update)" })),
		id: Type.Optional(Type.String({ description: "Todo id" })),
		reason: Type.Optional(Type.String({ description: "Human block reason (block)" })),
		verification: Type.Optional(Type.String({ description: "Done verification (done)" })),
		position: Type.Optional(Type.Number({ description: "Dashboard reorder only (move)" })),
		activeForm: Type.Optional(Type.String({ description: "In-progress form (add/update/start)" })),
		blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Dependency task ids (create)" })),
		addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Add dependency ids (update)" })),
		removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Remove dependency ids (update)" })),
		status: Type.Optional(
			StringEnum(["pending", "in_progress", "completed", "deleted"] as const, { description: "List filter" }),
		),
		includeDeleted: Type.Optional(Type.Boolean({ description: "Include deleted in list" })),
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage session todos (vendor task-graph). Actions: list/get/add/update/start/block/done/cancel/remove/clear. Results include TaskDetails for branch replay.",
		parameters: TodoParams,
		async execute(_toolCallId, params) {
			switch (params.action) {
				case "list": {
					const listed = listTodosViaVendor({
						status: params.status,
						includeDeleted: params.includeDeleted,
					});
					return textResult(listed.content || `No todos. ${DETAILS_HINT}`, listed.details);
				}
				case "get": {
					if (!params.id) return failResult("id required for get");
					const vendorId = resolveVendorTodoId(params.id);
					if (vendorId === undefined) return failResult(`Unknown todo id: ${params.id}`);
					const result = workflowController.apply((state) => mutateTodoViaVendor(state, "get", { id: vendorId }));
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "add": {
					if (!params.text) return failResult("text required for add");
					const result = workflowController.apply((state) =>
						mutateTodoViaVendor(state, "create", {
							subject: params.text!,
							description: params.description,
							owner: params.owner,
							activeForm: params.activeForm,
							blockedBy: params.blockedBy,
							metadata: state.goal?.id ? { goalId: state.goal.id } : undefined,
						}),
					);
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "update": {
					if (!params.id) return failResult("id required for update");
					const vendorId = resolveVendorTodoId(params.id);
					if (vendorId === undefined) return failResult(`Unknown todo id: ${params.id}`);
					const result = workflowController.apply((state) =>
						mutateTodoViaVendor(state, "update", {
							id: vendorId,
							subject: params.text,
							description: params.description,
							owner: params.owner,
							activeForm: params.activeForm,
							addBlockedBy: params.addBlockedBy,
							removeBlockedBy: params.removeBlockedBy,
						}),
					);
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "start": {
					if (!params.id) return failResult("id required for start");
					const vendorId = resolveVendorTodoId(params.id);
					if (vendorId === undefined) return failResult(`Unknown todo id: ${params.id}`);
					const result = workflowController.apply((state) =>
						mutateTodoViaVendor(state, "update", {
							id: vendorId,
							status: "in_progress",
							activeForm: params.activeForm,
							metadata: { qiStatus: null, qiBlockReason: null },
						}),
					);
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "block": {
					if (!params.id) return failResult("id required for block");
					if (!params.reason) return failResult("reason required for block");
					const result = workflowController.apply((state) =>
						blockTodoViaVendor(state, params.id!, params.reason!),
					);
					if (!result.ok) return failResult(result.error);
					const listed = listTodosViaVendor();
					return textResult(`Blocked todo ${shortId(params.id)}. ${DETAILS_HINT}`, listed.details);
				}
				case "done": {
					if (!params.id) return failResult("id required for done");
					const vendorId = resolveVendorTodoId(params.id);
					if (vendorId === undefined) return failResult(`Unknown todo id: ${params.id}`);
					const result = workflowController.apply((state) =>
						mutateTodoViaVendor(state, "update", {
							id: vendorId,
							status: "completed",
							metadata: {
								qiStatus: null,
								qiBlockReason: null,
								...(params.verification ? { verification: params.verification } : {}),
							},
						}),
					);
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "cancel":
				case "remove": {
					if (!params.id) return failResult("id required");
					const vendorId = resolveVendorTodoId(params.id);
					if (vendorId === undefined) return failResult(`Unknown todo id: ${params.id}`);
					const result = workflowController.apply((state) =>
						mutateTodoViaVendor(state, "delete", { id: vendorId }),
					);
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "clear": {
					const result = workflowController.apply((state) => clearTodosViaVendor(state));
					if (!result.ok) return failResult(result.error);
					return textResult(result.value.content, result.value.details);
				}
				case "move": {
					return failResult(
						"Reorder in /todos dashboard (Move up / Move down); vendor store has no position field",
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
			"Patch plan sections (discoveries, assumptions, decisions, steps, verification, unresolvedQuestions). Resets plan to draft. If no plan exists yet, automatically starts one (from the active goal/todo or goalHint). Optional revision for optimistic concurrency.",
		promptGuidelines: [
			"Call plan_update directly whenever you need to record plan sections — you do not need /plan first; a draft plan is auto-created if missing.",
			"Prefer updating steps/discoveries as you learn; use plan_mode_complete when the plan is decision-ready.",
		],
		parameters: Type.Object({
			discoveries: Type.Optional(Type.Array(Type.String())),
			assumptions: Type.Optional(Type.Array(Type.String())),
			decisions: Type.Optional(Type.Array(Type.String())),
			steps: Type.Optional(Type.Array(Type.String())),
			verification: Type.Optional(Type.Array(Type.String())),
			unresolvedQuestions: Type.Optional(Type.Array(Type.String())),
			goalHint: Type.Optional(Type.String({ description: "Goal used only when auto-creating a missing plan" })),
			revision: Type.Optional(Type.Number({ description: "Expected plan revision" })),
		}),
		async execute(_toolCallId, params) {
			const patch: Partial<PlanSections> = {};
			for (const key of sectionKeys) {
				if (params[key] !== undefined) patch[key] = params[key];
			}
			if (Object.keys(patch).length === 0) return failResult("At least one section patch is required");
			const hadPlan =
				!!workflowController.getState().plan && workflowController.getState().plan?.status !== "discarded";
			const result = workflowController.apply((state) =>
				updatePlanSections(state, patch, params.revision, params.goalHint),
			);
			if (!result.ok) return failResult(result.error);
			const changed = Object.keys(patch).join(", ");
			const created = hadPlan ? "" : ` Created plan "${result.value.goal}".`;
			return textResult(
				`Plan updated (rev ${result.value.revision}, ${changed}). Status: draft.${created} ${DETAILS_HINT}`,
				{
					action: "plan_update",
					revision: result.value.revision,
					status: result.value.status,
					created: !hadPlan,
				},
			);
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
		description:
			"Mark the draft plan ready with a decision-ready Markdown plan body. Auto-creates a draft plan if none exists.",
		parameters: Type.Object({
			plan: Type.String({ description: "Complete decision-ready implementation plan in Markdown" }),
			revision: Type.Optional(Type.Number({ description: "Expected plan revision" })),
			goalHint: Type.Optional(Type.String({ description: "Goal used only when auto-creating a missing plan" })),
		}),
		async execute(_toolCallId, params) {
			const normalized = normalizePlanBody(params.plan);
			if (!normalized.ok) return failResult(normalized.error);
			// Persist plan body into steps when empty / missing so ready conversion has content.
			const current = workflowController.getState().plan;
			const needsSteps = !current || current.status === "discarded" || current.sections.steps.length === 0;
			if (needsSteps) {
				const patched = workflowController.apply((state) =>
					updatePlanSections(state, { steps: [normalized.plan] }, params.revision, params.goalHint),
				);
				if (!patched.ok) return failResult(patched.error);
			}
			const result = workflowController.apply((state) => markPlanReady(state, params.revision, params.goalHint));
			if (!result.ok) return failResult(result.error);
			const completed = planModeCompleted(normalized.plan);
			return {
				...completed,
				details: {
					...completed.details,
					revision: result.value.revision,
					status: result.value.status,
				},
			};
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
					header: Type.String({
						maxLength: 16,
						description: "Short chip/tag (required, max 16 chars)",
					}),
					options: Type.Array(
						Type.Object({
							label: Type.String(),
							description: Type.String({ description: "Required explanation of the option" }),
							preview: Type.Optional(Type.String({ description: "Optional preview when focused" })),
						}),
						{ minItems: 2, maxItems: 4 },
					),
					multiSelect: Type.Optional(Type.Boolean()),
					allowFreeInput: Type.Optional(Type.Boolean()),
				}),
				{ minItems: 1, maxItems: 4 },
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return failResult("ask_user_question requires interactive UI");
			}

			const validated = validateAskQuestions(params.questions);
			if (!validated.ok) return failResult(validated.message);

			const answers: QuestionAnswer[] = [];

			for (let i = 0; i < params.questions.length; i++) {
				const q = params.questions[i]!;
				const options: QuestionOption[] = q.options.map((o) => ({
					label: o.label,
					description: o.description,
					preview: o.preview,
				}));
				const opened = workflowController.apply((state) =>
					openQuestion(state, q.prompt, options, {
						header: q.header,
						multiSelect: q.multiSelect,
						allowFreeInput: q.allowFreeInput,
						questionIndex: i + 1,
						questionCount: params.questions.length,
					}),
				);
				if (!opened.ok) return failResult(opened.error);

				const overlay = await showQuestionOverlay(ctx, workflowController);
				if (overlay.action === "cancelled") {
					const envelope = buildAskEnvelope(validated.params, answers, true);
					return { ...envelope, details: { ...envelope.details, action: "ask_user_question" } };
				}
				const mapped = mapOverlayToAnswer(validated.params, i, {
					selected: overlay.selected,
					freeInput: overlay.freeInput,
				});
				if (overlay.notes) mapped.notes = overlay.notes;
				answers.push(mapped);
			}

			const envelope = buildAskEnvelope(validated.params, answers, false);
			return { ...envelope, details: { ...envelope.details, action: "ask_user_question" } };
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
			const err = text.startsWith("Error:") || text.includes("declined");
			return new Text(theme.fg(err ? "error" : "accent", summarize(text, 100)), 0, 0);
		},
	});

	pi.registerTool({
		name: "process",
		label: "Process",
		description: "Manage background jobs: start, list, status, logs, output, wait, cancel, clear, write (stdin).",
		parameters: Type.Object({
			action: StringEnum(["start", "list", "status", "logs", "output", "wait", "cancel", "clear", "write"] as const),
			name: Type.Optional(Type.String({ description: "Job name (start)" })),
			command: Type.Optional(Type.String({ description: "Shell command (start)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (start)" })),
			id: Type.Optional(Type.String({ description: "Job id" })),
			tail: Type.Optional(Type.Number({ description: "Log/output tail lines" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout ms (wait); 0 = no timeout" })),
			input: Type.Optional(Type.String({ description: "Stdin data (write)" })),
			end: Type.Optional(Type.Boolean({ description: "Close stdin after write (write)" })),
			stream: Type.Optional(StringEnum(["stdout", "stderr", "both"] as const, { description: "output stream" })),
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
				case "list": {
					const jobs = jobManager.list();
					if (jobs.length === 0) return textResult("No jobs.", { action: "list", jobs: [] });
					const lines = jobs.map(
						(j) =>
							`${shortId(j.id)} [${j.status}] ${j.name}${j.exitCode !== undefined ? ` exit=${j.exitCode}` : ""}`,
					);
					return textResult(lines.join("\n"), {
						action: "list",
						jobs: jobs.map((j) => ({ id: j.id, status: j.status, name: j.name })),
					});
				}
				case "output": {
					if (!params.id) return failResult("id required for output");
					try {
						const out = jobManager.output(params.id, {
							tail: params.tail,
							stream: params.stream ?? "both",
						});
						return textResult(out.text || "(no output)", {
							action: "output",
							id: params.id,
							stdoutBytes: out.stdoutBytes,
							stderrBytes: out.stderrBytes,
						});
					} catch (err) {
						return failResult(err instanceof Error ? err.message : String(err));
					}
				}
				case "clear": {
					const n = jobManager.clearFinished();
					return textResult(`Cleared ${n} finished job(s).`, { action: "clear", count: n });
				}
				case "write": {
					if (!params.id) return failResult("id required for write");
					if (params.input === undefined) return failResult("input required for write");
					try {
						jobManager.write(params.id, params.input, { end: params.end === true });
						return textResult(
							`Wrote ${params.input.length} bytes to job ${shortId(params.id)} stdin${params.end ? " (closed)" : ""}.`,
							{ action: "write", id: params.id, bytes: params.input.length, end: params.end === true },
						);
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
