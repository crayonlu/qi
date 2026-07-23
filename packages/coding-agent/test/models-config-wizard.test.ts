import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { upsertProvider } from "../src/core/models-jsonc/index.ts";
import {
	runModelsAddWizard,
	runModelsRemoveProvider,
	runModelsValidate,
	saveAndReload,
} from "../src/modes/interactive/models-config/commands.ts";

describe("models add wizard cancel / validate", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("cancel on first select does not write models.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qi-models-wiz-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		const notify = vi.fn();
		const host = {
			ui: {
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => false),
				input: vi.fn(async () => undefined),
				notify,
			},
			modelRegistry: {
				refresh: vi.fn(async () => {}),
				getError: () => undefined,
				find: () => undefined,
			} as unknown as ModelRegistry,
			getModelsPath: () => path,
		};
		await runModelsAddWizard(host);
		expect(() => readFileSync(path, "utf-8")).toThrow();
		expect(host.modelRegistry.refresh).not.toHaveBeenCalled();
	});

	it("validate reports ok for empty providers without writing secrets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qi-models-val-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(
			path,
			`{
  "providers": {
    "acme": {
      "api": "openai-completions",
      "baseUrl": "https://acme.test/v1",
      "apiKey": "sk-literal-secret",
      "models": [{ "id": "m1", "input": ["text"] }]
    }
  }
}
`,
			"utf-8",
		);
		const messages: string[] = [];
		const host = {
			ui: {
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => false),
				input: vi.fn(async () => undefined),
				notify: (message: string) => {
					messages.push(message);
				},
			},
			modelRegistry: {
				refresh: vi.fn(async () => {}),
				getError: () => undefined,
				find: () => undefined,
			} as unknown as ModelRegistry,
			getModelsPath: () => path,
		};
		await runModelsValidate(host);
		expect(messages.join("\n")).toContain("models.json OK");
		expect(messages.join("\n")).toContain("literal value");
		expect(messages.join("\n")).not.toContain("sk-literal-secret");
	});

	it("reload failure keeps file, reports saved-but-reload-failed, and sets no pending switch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qi-models-reload-fail-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(path, `{ "providers": {} }\n`, "utf-8");
		const host = {
			ui: {
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => true),
				input: vi.fn(async () => undefined),
				notify: vi.fn(),
			},
			modelRegistry: {
				refresh: vi.fn(async () => {
					throw new Error("boom-refresh");
				}),
				getError: () => undefined,
				find: () => undefined,
			} as unknown as ModelRegistry,
			getModelsPath: () => path,
		};

		const mutation = upsertProvider(`{ "providers": {} }\n`, "acme", {
			api: "openai-completions",
			baseUrl: "https://acme.test/v1",
			apiKey: "$ACME_KEY",
			models: [{ id: "m1", input: ["text"] }],
		});
		expect(mutation.ok).toBe(true);
		if (!mutation.ok) return;

		const saved = await saveAndReload(host, mutation);
		expect(saved.ok).toBe(false);
		if (saved.ok) return;
		expect(saved.error).toContain("Saved models.json but reload failed");
		expect(saved.error).toContain("boom-refresh");
		expect(saved.error).toContain("/model was not updated");
		expect(readFileSync(path, "utf-8")).toContain('"acme"');
		expect((host as { pendingSwitch?: unknown }).pendingSwitch).toBeUndefined();
	});

	it("invalid provider id on remove does not write", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qi-models-bad-id-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		const initial = `{
  "providers": {
    "acme": { "api": "openai-completions", "baseUrl": "https://acme.test/v1", "models": [] }
  }
}
`;
		writeFileSync(path, initial, "utf-8");
		const messages: string[] = [];
		const host = {
			ui: {
				select: vi.fn(async () => undefined),
				confirm: vi.fn(async () => true),
				input: vi.fn(async () => undefined),
				notify: (message: string) => {
					messages.push(message);
				},
			},
			modelRegistry: {
				refresh: vi.fn(async () => {}),
				getError: () => undefined,
				find: () => undefined,
			} as unknown as ModelRegistry,
			getModelsPath: () => path,
		};
		await runModelsRemoveProvider(host, "bad id");
		expect(messages.join("\n")).toMatch(/whitespace|Provider id/i);
		expect(host.modelRegistry.refresh).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf-8")).toBe(initial);
	});
});
