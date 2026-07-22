/**
 * Local shim so adopted vendor sources can import coding-agent APIs without
 * resolving the published package name from inside the monorepo source tree.
 */
export type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
export { getAgentDir } from "../../../config.ts";
export { convertToLlm } from "../../../core/messages.ts";
export { ModelRegistry } from "../../../core/model-registry.ts";
export { DefaultResourceLoader } from "../../../core/resource-loader.ts";
export { createAgentSession } from "../../../core/sdk.ts";
export { SessionManager, type SessionEntry } from "../../../core/session-manager.ts";
export { SettingsManager } from "../../../core/settings-manager.ts";
export {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUIContext,
	type ToolInfo,
	type ToolRenderResultOptions,
} from "../../../core/extensions/types.ts";
export { withFileMutationQueue } from "../../../core/tools/file-mutation-queue.ts";
export { BorderedLoader } from "../../../modes/interactive/components/bordered-loader.ts";
export { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
export { getMarkdownTheme, Theme, type ThemeColor } from "../../../modes/interactive/theme/theme.ts";
export { parseFrontmatter } from "../../../utils/frontmatter.ts";
