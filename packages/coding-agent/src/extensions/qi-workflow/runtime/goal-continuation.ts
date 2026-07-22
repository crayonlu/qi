import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import { claimContinuation, clearContinuationTicket } from "../domain/index.ts";

interface PendingContinuation {
	ticket: string;
	prompt: string;
}

/**
 * Goal continuation: claim a ticket on agent_end, dispatch once on agent_settled when idle.
 * Ticket binding prevents duplicate sendUserMessage for the same goal iteration.
 */
export function attachGoalContinuation(pi: ExtensionAPI): void {
	let pending: PendingContinuation | undefined;

	pi.on("agent_end", (_event, _ctx) => {
		const claimed = workflowController.apply((state) => claimContinuation(state));
		if (!claimed.ok || !claimed.value) return;
		pending = claimed.value;
	});

	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		const ticket = pending;
		if (!ticket) return;
		if (!ctx.isIdle()) return;

		const goal = workflowController.getState().goal;
		if (!goal || goal.status !== "active" || goal.continuationTicket !== ticket.ticket) {
			pending = undefined;
			return;
		}

		// Drop local pending first so a re-entrant settled cannot double-dispatch.
		pending = undefined;
		pi.sendUserMessage(ticket.prompt, { deliverAs: "followUp" });
		workflowController.apply((state) => clearContinuationTicket(state, ticket.ticket));
	});
}
