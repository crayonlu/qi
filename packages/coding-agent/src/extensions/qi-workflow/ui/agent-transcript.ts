/**
 * Build display messages for Agent View transcript focus from ManagedAgent history.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ManagedAgent } from "../vendor/subagents/registry.ts";

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Synthetic transcript from persisted turn history (subprocess + in-process fallback). */
export function agentHistoryToMessages(agent: ManagedAgent): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let ts = agent.createdAt || Date.now();
	for (const turn of agent.history) {
		messages.push({
			role: "user",
			content: turn.task,
			timestamp: turn.startedAt || ts++,
		});
		if (turn.output?.trim()) {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: turn.output }],
				api: "unknown",
				provider: "subagent",
				model: agent.model ?? agent.agent,
				usage: emptyUsage(),
				stopReason: turn.exitCode === 0 ? "stop" : "error",
				timestamp: turn.completedAt || ts++,
			});
		}
	}
	if (agent.currentTask?.trim()) {
		messages.push({
			role: "user",
			content: agent.currentTask,
			timestamp: agent.updatedAt || Date.now(),
		});
	}
	if (agent.error?.trim() && !agent.currentTask) {
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: agent.error }],
			api: "unknown",
			provider: "subagent",
			model: agent.model ?? agent.agent,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: agent.error,
			timestamp: agent.updatedAt || Date.now(),
		});
	}
	return messages;
}
