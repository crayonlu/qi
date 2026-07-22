// @ts-nocheck
import type { ExtensionContext } from "../../../pi-coding-agent-shim.ts";
import type { ExecuteResult, ProcessAction } from "../../constants/index.ts";
import type { ProcessManager } from "../../manager.ts";
import { executeClear } from "./clear.ts";
import { executeKill } from "./kill.ts";
import { executeList } from "./list.ts";
import { executeLogs } from "./logs.ts";
import { executeOutput } from "./output.ts";
import { executeStart } from "./start.ts";
import { executeWrite } from "./write.ts";

interface ActionParams {
  action: ProcessAction | string;
  command?: string;
  name?: string;
  id?: string;
  input?: string;
  end?: boolean;
  alertOnSuccess?: boolean;
  alertOnFailure?: boolean;
  alertOnKill?: boolean;
  logWatches?: Array<{
    pattern: string;
    stream?: "stdout" | "stderr" | "both";
    repeat?: boolean;
  }>;
}

export async function executeAction(
  params: ActionParams,
  manager: ProcessManager,
  ctx: ExtensionContext,
): Promise<ExecuteResult> {
  switch (params.action) {
    case "start":
      return executeStart(params, manager, ctx);
    case "list":
      return executeList(manager);
    case "output":
      return executeOutput(params, manager);
    case "logs":
      return executeLogs(params, manager);
    case "kill":
      return executeKill(params, manager);
    case "clear":
      return executeClear(manager);
    case "write":
      return executeWrite(params, manager);
    default:
      return {
        content: [{ type: "text", text: `Unknown action: ${params.action}` }],
        details: {
          action: params.action as ProcessAction,
          success: false,
          message: `Unknown action: ${params.action}`,
        },
      };
  }
}
