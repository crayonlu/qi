/**
 * Thin Qi adapter over adopted rpiv-ask-user-question validation.
 * Qi keeps docs/07 bottom-center overlay; vendor owns questionnaire rules.
 */

import type { QuestionParams } from "../vendor/ask/tool/types.ts";
import { validateQuestionnaire } from "../vendor/ask/tool/validate-questionnaire.ts";

export interface AskValidationOk {
	ok: true;
	params: QuestionParams;
}

export interface AskValidationErr {
	ok: false;
	message: string;
}

export function validateAskQuestions(
	questions: Array<{
		prompt: string;
		header?: string;
		options: Array<{ label: string; description?: string }>;
		multiSelect?: boolean;
	}>,
): AskValidationOk | AskValidationErr {
	const params: QuestionParams = {
		questions: questions.map((q) => ({
			question: q.prompt,
			header: (q.header ?? q.prompt).slice(0, 16),
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description ?? o.label,
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

export function peekAskVendorReachable(): boolean {
	const ok = validateAskQuestions([
		{
			prompt: "Pick one?",
			header: "Pick",
			options: [
				{ label: "A", description: "Option A" },
				{ label: "B", description: "Option B" },
			],
		},
	]);
	return ok.ok;
}
