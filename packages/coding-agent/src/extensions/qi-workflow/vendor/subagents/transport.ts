// @ts-nocheck
import type { ManagedAgent, TurnOutcome } from "./registry.ts";

export interface SubagentTransport {
	readonly kind: "subprocess" | "in-process" | "fake";
	runTurn(agent: ManagedAgent, task: string, signal: AbortSignal): Promise<TurnOutcome>;
	release?(agent: ManagedAgent): Promise<void>;
	shutdown?(): Promise<void>;
}

export type AgentTurnRunner = (
	agent: ManagedAgent,
	task: string,
	signal: AbortSignal,
) => Promise<TurnOutcome>;

export class FunctionTransport implements SubagentTransport {
	readonly kind = "fake" as const;
	private readonly runner: AgentTurnRunner;

	constructor(runner: AgentTurnRunner) {
		this.runner = runner;
	}

	runTurn(agent: ManagedAgent, task: string, signal: AbortSignal): Promise<TurnOutcome> {
		return this.runner(agent, task, signal);
	}
}

export function normalizeTransport(
	transport: SubagentTransport | AgentTurnRunner,
): SubagentTransport {
	return typeof transport === "function" ? new FunctionTransport(transport) : transport;
}
