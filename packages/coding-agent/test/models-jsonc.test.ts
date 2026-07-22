import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	addModelToProvider,
	atomicWriteModelsJsonc,
	parseModelsJsoncContent,
	readModelsJsonc,
	redactSecretsInText,
	redactSecretValue,
	removeProvider,
	upsertProvider,
	validateModelId,
	validateProviderId,
} from "../src/core/models-jsonc/index.ts";

describe("models-jsonc mutations", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempModelsPath(initial?: string): string {
		const dir = mkdtempSync(join(tmpdir(), "qi-models-jsonc-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		if (initial !== undefined) writeFileSync(path, initial, "utf-8");
		return path;
	}

	it("creates provider + model while preserving JSONC comments and trailing commas", async () => {
		const path = tempModelsPath(`{
  // keep me
  "providers": {
  },
}
`);
		const { content } = await readModelsJsonc(path);
		const mutation = upsertProvider(content, "acme", {
			api: "openai-completions",
			baseUrl: "https://acme.test/v1",
			apiKey: "$ACME_API_KEY",
			models: [{ id: "acme-large", name: "Acme Large", reasoning: false, input: ["text"] }],
		});
		expect(mutation.ok).toBe(true);
		if (!mutation.ok) return;
		const write = await atomicWriteModelsJsonc(path, mutation.content);
		expect(write.ok).toBe(true);
		const saved = readFileSync(path, "utf-8");
		expect(saved).toContain("// keep me");
		expect(saved).toContain("$ACME_API_KEY");
		expect(saved).toContain("acme-large");
		expect(parseModelsJsoncContent(saved).ok).toBe(true);
	});

	it("successful write creates a readable valid models.json", async () => {
		const path = tempModelsPath();
		const content = `{
  "providers": {
    "ok": {
      "api": "openai-completions",
      "baseUrl": "https://ok.test/v1",
      "apiKey": "$OK_KEY",
      "models": [{ "id": "m1", "input": ["text"] }]
    }
  }
}
`;
		const write = await atomicWriteModelsJsonc(path, content);
		expect(write.ok).toBe(true);
		const saved = readFileSync(path, "utf-8");
		expect(parseModelsJsoncContent(saved).ok).toBe(true);
		expect(saved).toContain('"ok"');
		expect(readdirSync(join(path, "..")).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("failed write path does not leave an empty .models.json.*.tmp file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "qi-models-jsonc-fail-"));
		dirs.push(dir);
		// Target path is a directory so rename(tmp → path) fails after temp write.
		const path = join(dir, "models.json");
		mkdirSync(path);
		const content = `{ "providers": {} }`;
		const write = await atomicWriteModelsJsonc(path, content);
		expect(write.ok).toBe(false);
		const leftovers = readdirSync(dir).filter((name) => /\.models\.json\..*\.tmp$/.test(name));
		expect(leftovers).toEqual([]);
	});

	it("adds a model to an existing provider", async () => {
		const path = tempModelsPath(`{
  "providers": {
    "acme": {
      "api": "openai-completions",
      "baseUrl": "https://acme.test/v1",
      "apiKey": "$ACME_API_KEY",
      "models": [{ "id": "one", "input": ["text"] }]
    }
  }
}
`);
		const { content } = await readModelsJsonc(path);
		const mutation = addModelToProvider(content, "acme", {
			id: "two",
			input: ["text"],
		});
		expect(mutation.ok).toBe(true);
		if (!mutation.ok) return;
		await atomicWriteModelsJsonc(path, mutation.content);
		const saved = readFileSync(path, "utf-8");
		expect(saved).toContain('"one"');
		expect(saved).toContain('"two"');
	});

	it("rejects duplicate provider without replace and does not write", async () => {
		const initial = `{
  "providers": {
    "acme": { "api": "openai-completions", "baseUrl": "https://acme.test/v1", "models": [] }
  }
}
`;
		const path = tempModelsPath(initial);
		const { content } = await readModelsJsonc(path);
		const mutation = upsertProvider(content, "acme", {
			api: "openai-completions",
			baseUrl: "https://other.test/v1",
			models: [{ id: "x", input: ["text"] }],
		});
		expect(mutation.ok).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe(initial);
	});

	it("validates schema and refuses invalid documents on write", async () => {
		const path = tempModelsPath(`{ "providers": {} }`);
		const write = await atomicWriteModelsJsonc(path, `{ "providers": { "bad": { "models": [{ }] } } }`);
		expect(write.ok).toBe(false);
		expect(readFileSync(path, "utf-8")).toContain('"providers"');
	});

	it("preserves unknown valid fields", async () => {
		const path = tempModelsPath(`{
  "providers": {
    "acme": {
      "api": "openai-completions",
      "baseUrl": "https://acme.test/v1",
      "futureFlag": true,
      "models": [{ "id": "one", "input": ["text"], "experimental": 1 }]
    }
  }
}
`);
		const { content } = await readModelsJsonc(path);
		const mutation = addModelToProvider(content, "acme", { id: "two", input: ["text"] });
		expect(mutation.ok).toBe(true);
		if (!mutation.ok) return;
		await atomicWriteModelsJsonc(path, mutation.content);
		const saved = readFileSync(path, "utf-8");
		expect(saved).toContain("futureFlag");
	});

	it("redacts literal secrets but keeps env references", () => {
		expect(redactSecretValue("$FOO_KEY")).toBe("$FOO_KEY");
		expect(redactSecretValue("$(op read x)")).toBe("$(op read x)");
		expect(redactSecretValue("sk-secret-value")).not.toContain("secret-value");
		expect(redactSecretsInText('"apiKey": "sk-abcdefgh"')).not.toContain("sk-abcdefgh");
	});

	it("reload makes a new model visible through ModelRegistry", async () => {
		const path = tempModelsPath(`{ "providers": {} }`);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: path,
			allowModelNetwork: false,
		});
		const registry = new ModelRegistry(runtime);

		const { content } = await readModelsJsonc(path);
		const mutation = upsertProvider(content, "local-test", {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "$LOCAL_TEST_KEY",
			models: [{ id: "visible-now", input: ["text"] }],
		});
		expect(mutation.ok).toBe(true);
		if (!mutation.ok) return;
		const write = await atomicWriteModelsJsonc(path, mutation.content);
		expect(write.ok).toBe(true);
		await registry.refresh();
		expect(registry.find("local-test", "visible-now")).toBeDefined();
	});

	it("remove provider requires mutation result and can write", async () => {
		const path = tempModelsPath(`{
  "providers": {
    "gone": { "api": "openai-completions", "baseUrl": "https://x.test", "models": [] }
  }
}
`);
		const { content } = await readModelsJsonc(path);
		const mutation = removeProvider(content, "gone");
		expect(mutation.ok).toBe(true);
		if (!mutation.ok) return;
		await atomicWriteModelsJsonc(path, mutation.content);
		expect(readFileSync(path, "utf-8")).not.toContain('"gone"');
	});
});

describe("models id validation", () => {
	it("rejects invalid provider and model ids without write", () => {
		expect(validateProviderId("").ok).toBe(false);
		expect(validateProviderId("  ").ok).toBe(false);
		expect(validateProviderId("bad id").ok).toBe(false);
		expect(validateProviderId("a/b").ok).toBe(false);
		expect(validateProviderId("x".repeat(65)).ok).toBe(false);
		expect(validateProviderId("acme").ok).toBe(true);

		expect(validateModelId("").ok).toBe(false);
		expect(validateModelId("has space").ok).toBe(false);
		expect(validateModelId("org/model").ok).toBe(false);
		expect(validateModelId("x".repeat(129)).ok).toBe(false);
		expect(validateModelId("gpt-4.1").ok).toBe(true);
	});
});
