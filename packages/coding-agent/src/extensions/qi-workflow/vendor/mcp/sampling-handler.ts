/**
 * Stub: MCP sampling UI omitted from Qi adoption (optional / heavy).
 * Copyright (c) 2026 Nico Bailon — MIT (see ../LICENSE.pi-mcp-adapter.md)
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface SamplingHandlerOptions {
	serverName: string;
	autoApprove?: boolean;
	ui?: unknown;
	modelRegistry?: unknown;
	getCurrentModel?: () => unknown;
	getSignal?: () => AbortSignal | undefined;
}

export type ServerSamplingConfig = Omit<SamplingHandlerOptions, "serverName">;

export function registerSamplingHandler(_client: Client, _options: SamplingHandlerOptions): void {
	// Sampling UI intentionally not adopted.
}
