import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { runModelsAddWizard, runModelsValidate } from "../src/modes/interactive/models-config/commands.ts";

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
		const { writeFileSync } = await import("node:fs");
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
});
