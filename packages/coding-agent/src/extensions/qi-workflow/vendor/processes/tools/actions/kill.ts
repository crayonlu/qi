// @ts-nocheck
import type { ExecuteResult } from "../../constants/index.ts";
import type { ProcessManager } from "../../manager.ts";

interface KillParams {
  id?: string;
}

export async function executeKill(
  params: KillParams,
  manager: ProcessManager,
): Promise<ExecuteResult> {
  if (!params.id) {
    return {
      content: [{ type: "text", text: "Missing required parameter: id" }],
      details: {
        action: "kill",
        success: false,
        message: "Missing required parameter: id",
      },
    };
  }

  const proc = manager.get(params.id);
  if (!proc) {
    const message = `Process not found: ${params.id}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "kill",
        success: false,
        message,
      },
    };
  }

  const result = await manager.kill(proc.id, {
    signal: "SIGTERM",
    timeoutMs: 3000,
  });

  if (result.ok) {
    const message = `Terminated "${proc.name}" (${proc.id})`;
    return {
      content: [{ type: "text", text: message }],
      details: { action: "kill", success: true, message },
    };
  }

  if (result.reason === "timeout") {
    const message =
      `SIGTERM timed out for "${proc.name}" (${proc.id}). ` +
      "The process may still be running in terminate_timeout state. Use kill again or SIGKILL manually if needed.";
    return {
      content: [{ type: "text", text: message }],
      details: { action: "kill", success: false, message },
    };
  }

  const message = `Failed to terminate "${proc.name}" (${proc.id})`;
  return {
    content: [{ type: "text", text: message }],
    details: { action: "kill", success: false, message },
  };
}
