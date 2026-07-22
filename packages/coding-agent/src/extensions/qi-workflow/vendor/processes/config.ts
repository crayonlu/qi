// @ts-nocheck
/**
 * Minimal config for the processes extension (mac-fork).
 * Drops the @aliou/pi-utils-settings dependency and the UI-only keybinding/widget config.
 *
 * Global config file (optional): ~/.pi/agent/extensions/process.json
 * Only `execution.shellPath` and `output.*` are honored.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ResolvedProcessesConfig {
  output: {
    defaultTailLines: number;
    maxOutputLines: number;
  };
  execution: {
    shellPath?: string;
  };
}

const DEFAULT_CONFIG: ResolvedProcessesConfig = {
  output: {
    defaultTailLines: 50,
    maxOutputLines: 500,
  },
  execution: {
    shellPath: undefined,
  },
};

function configFilePath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "process.json");
}

class ConfigLoader {
  private config: ResolvedProcessesConfig = DEFAULT_CONFIG;

  load(): void {
    const path = configFilePath();
    if (!existsSync(path)) {
      this.config = DEFAULT_CONFIG;
      return;
    }
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ResolvedProcessesConfig>;
      this.config = {
        output: {
          defaultTailLines:
            parsed.output?.defaultTailLines ??
            DEFAULT_CONFIG.output.defaultTailLines,
          maxOutputLines:
            parsed.output?.maxOutputLines ?? DEFAULT_CONFIG.output.maxOutputLines,
        },
        execution: {
          shellPath: parsed.execution?.shellPath,
        },
      };
    } catch {
      this.config = DEFAULT_CONFIG;
    }
  }

  getConfig(): ResolvedProcessesConfig {
    return this.config;
  }
}

export const configLoader = new ConfigLoader();

// Ensure the config dir exists so users can drop a process.json in later.
mkdirSync(dirname(configFilePath()), { recursive: true });
