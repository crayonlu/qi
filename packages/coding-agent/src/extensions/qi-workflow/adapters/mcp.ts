/**
 * MCP adapter helpers — lifecycle disable/enable/health around vendor manager.
 */

import { mcpManager } from "../runtime/mcp-manager.ts";
import { McpLifecycleManager } from "../vendor/mcp/lifecycle.ts";
import { McpServerManager } from "../vendor/mcp/server-manager.ts";

export function peekMcpVendorReachable(): boolean {
	const manager = new McpServerManager();
	const lifecycle = new McpLifecycleManager(manager);
	return typeof lifecycle.markKeepAlive === "function" && typeof lifecycle.unmarkKeepAlive === "function";
}

export { mcpManager, McpLifecycleManager, McpServerManager };
