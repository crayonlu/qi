/**
 * Local shim so adopted vendor sources can import coding-agent APIs.
 */
export type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
export { getAgentDir } from "../../../config.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	ToolInfo,
	ToolRenderResultOptions,
} from "../../../core/extensions/types.ts";
export { withFileMutationQueue } from "../../../core/tools/file-mutation-queue.ts";
export type { Theme } from "../../../modes/interactive/theme/theme.ts";
export { parseFrontmatter } from "../../../utils/frontmatter.ts";
