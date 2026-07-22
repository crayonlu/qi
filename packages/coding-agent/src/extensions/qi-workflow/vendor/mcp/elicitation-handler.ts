/**
 * Stub: MCP elicitation UI omitted from Qi adoption (optional / heavy).
 * Copyright (c) 2026 Nico Bailon — MIT (see ../LICENSE.pi-mcp-adapter.md)
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ElicitRequestURLParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionUIContext } from "../pi-coding-agent-shim.ts";

export type ElicitationUIContext = ExtensionUIContext;

export interface ElicitationHandlerOptions {
	serverName: string;
	ui: ElicitationUIContext;
	allowUrl: boolean;
	onUrlAccepted?: (elicitationId: string) => void;
}

export type ServerElicitationConfig = Omit<ElicitationHandlerOptions, "serverName" | "onUrlAccepted">;

export function registerElicitationHandler(_client: Client, _options: ElicitationHandlerOptions): void {
	// Elicitation UI intentionally not adopted.
}

export async function handleUrlElicitation(
	_options: ElicitationHandlerOptions,
	_params: ElicitRequestURLParams,
): Promise<ElicitResult> {
	return { action: "cancel" };
}
