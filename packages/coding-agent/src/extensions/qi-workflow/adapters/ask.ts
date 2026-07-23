/**
 * Thin Qi adapter over adopted rpiv-ask-user-question validation + envelope.
 * Qi keeps bottom-center overlay; vendor owns questionnaire rules and LLM envelope.
 */

import { buildQuestionnaireResponse, DECLINE_MESSAGE } from "../vendor/ask/tool/response-envelope.ts";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "../vendor/ask/tool/types.ts";
import { MAX_OPTIONS, MAX_QUESTIONS } from "../vendor/ask/tool/types.ts";
import { validateQuestionnaire } from "../vendor/ask/tool/validate-questionnaire.ts";

export interface AskValidationOk {
	ok: true;
	params: QuestionParams;
}

export interface AskValidationErr {
	ok: false;
	message: string;
}

export interface AskQuestionInput {
	/** Prompt text (Qi tool param name); maps to vendor `question`. */
	prompt: string;
	header: string;
	options: Array<{ label: string; description: string; preview?: string }>;
	multiSelect?: boolean;
}

/** Enforce upstream-required header/description; no soft defaults that hide schema weakenings. */
export function validateAskQuestions(questions: AskQuestionInput[]): AskValidationOk | AskValidationErr {
	if (questions.length === 0 || questions.length > MAX_QUESTIONS) {
		return {
			ok: false,
			message: `Error: Provide between 1 and ${MAX_QUESTIONS} questions`,
		};
	}
	for (const q of questions) {
		if (!q.header?.trim()) {
			return { ok: false, message: "Error: Each question requires a non-empty header (max 16 chars)" };
		}
		if (q.options.length > MAX_OPTIONS) {
			return { ok: false, message: `Error: At most ${MAX_OPTIONS} options are allowed per question` };
		}
		for (const o of q.options) {
			if (!o.description?.trim()) {
				return { ok: false, message: "Error: Each option requires a description" };
			}
		}
	}
	const params: QuestionParams = {
		questions: questions.map((q) => ({
			question: q.prompt,
			header: q.header.trim().slice(0, 16),
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				...(o.preview !== undefined ? { preview: o.preview } : {}),
			})),
			multiSelect: q.multiSelect,
		})),
	};
	const result = validateQuestionnaire(params);
	if (!result.ok) {
		return { ok: false, message: result.message };
	}
	return { ok: true, params };
}

export function buildAskEnvelope(
	params: QuestionParams,
	answers: QuestionAnswer[],
	cancelled: boolean,
): { content: Array<{ type: "text"; text: string }>; details: QuestionnaireResult } {
	return buildQuestionnaireResponse({ answers, cancelled }, params);
}

export function mapOverlayToAnswer(
	params: QuestionParams,
	questionIndex: number,
	overlay: { selected: string[]; freeInput?: string },
): QuestionAnswer {
	const q = params.questions[questionIndex]!;
	const question = q.question;
	if (q.multiSelect) {
		return {
			questionIndex,
			question,
			kind: "multi",
			answer: null,
			selected: overlay.selected,
		};
	}
	if (overlay.freeInput?.trim()) {
		return {
			questionIndex,
			question,
			kind: "custom",
			answer: overlay.freeInput.trim(),
		};
	}
	const label = overlay.selected[0] ?? null;
	const matched = q.options.find((o) => o.label === label);
	return {
		questionIndex,
		question,
		kind: "option",
		answer: label,
		...(matched?.preview ? { preview: matched.preview } : {}),
	};
}

export function peekAskVendorReachable(): boolean {
	const ok = validateAskQuestions([
		{
			prompt: "Pick one?",
			header: "Pick",
			options: [
				{ label: "A", description: "Option A" },
				{ label: "B", description: "Option B", preview: "preview B" },
			],
		},
	]);
	if (!ok.ok) return false;
	const envelope = buildAskEnvelope(ok.params, [], true);
	return envelope.content[0]?.text === DECLINE_MESSAGE;
}

export { DECLINE_MESSAGE };
export {
	ASK_USER_QUESTION_TOOL_NAME,
	reconcileAskUserQuestionTool,
	registerAskUserQuestionReconciler,
} from "./ask-reconcile.ts";
