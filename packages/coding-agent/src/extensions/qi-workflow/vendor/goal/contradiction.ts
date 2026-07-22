/**
 * Contradiction checks adopted from pi-goal runtime.
 * Copyright (c) 2026 narumiruna — MIT (see ../LICENSE.pi-goal.md)
 */

const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;

export function isContradictoryCompletionSummary(summary: string): boolean {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}
