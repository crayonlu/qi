/**
 * Apply transcript focus to ExtensionUIContext (chat column swap).
 */

import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import { getStatefulAgent } from "../vendor/subagents/agent-bridge.ts";
import { agentHistoryToMessages } from "./agent-transcript.ts";
import {
	enterTranscriptFocus,
	exitTranscriptFocus,
	getTranscriptFocus,
	type TranscriptFocus,
} from "./transcript-focus.ts";

export const TRANSCRIPT_FOCUS_STATUS_KEY = "qi-focus";

function shortId(id: string): string {
	const parts = id.split(/[_-]/);
	const last = parts[parts.length - 1] ?? id;
	return last.slice(0, 8);
}

function agentLabel(agentId: string): string {
	const agent = getStatefulAgent(agentId);
	if (!agent) return shortId(agentId);
	return `${agent.agent}:${shortId(agentId)}`;
}

export function syncTranscriptSourceToUi(ui: ExtensionUIContext): void {
	const focus = getTranscriptFocus();
	if (focus.kind === "main") {
		ui.setTranscriptSource({ kind: "main" });
		ui.setStatus(TRANSCRIPT_FOCUS_STATUS_KEY, undefined);
		return;
	}
	const label = agentLabel(focus.agentId);
	ui.setStatus(TRANSCRIPT_FOCUS_STATUS_KEY, `@${label}`);
	ui.setTranscriptSource({
		kind: "agent",
		agentId: focus.agentId,
		label,
		getMessages: () => {
			const agent = getStatefulAgent(focus.agentId);
			return agent ? agentHistoryToMessages(agent) : [];
		},
	});
}

export function focusAgentTranscript(ui: ExtensionUIContext, agentId: string): TranscriptFocus {
	const next = enterTranscriptFocus(agentId);
	syncTranscriptSourceToUi(ui);
	return next;
}

export function unfocusAgentTranscript(ui: ExtensionUIContext): TranscriptFocus {
	const next = exitTranscriptFocus();
	syncTranscriptSourceToUi(ui);
	return next;
}
