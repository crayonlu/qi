/**
 * JSONC-preserving models.json mutations via jsonc-parser edit API.
 * Never rewrite the whole file with JSON.stringify.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import {
	type ModelsJson,
	type ModelsJsonModel,
	type ModelsJsonProvider,
	validateModelsJsonDocument,
} from "../model-config.ts";

export type ModelsJsoncMutationResult =
	| { ok: true; content: string; document: ModelsJson; summary: string; patchPreview: string }
	| { ok: false; error: string };

const FORMATTING = {
	insertSpaces: true,
	tabSize: 2,
	eol: "\n",
	keepLines: true,
} as const;

export async function readModelsJsonc(path: string): Promise<{ content: string; exists: boolean }> {
	try {
		const content = await readFile(path, "utf-8");
		return { content, exists: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { content: '{\n  "providers": {}\n}\n', exists: false };
		}
		throw error;
	}
}

export function parseModelsJsoncContent(content: string): ModelsJsoncMutationResult {
	const errors: { error: number; offset: number; length: number }[] = [];
	const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		return { ok: false, error: `Failed to parse models.json JSONC (${errors.length} error(s))` };
	}
	const validated = validateModelsJsonDocument(parsed);
	if (!validated.ok) return validated;
	return {
		ok: true,
		content,
		document: validated.value,
		summary: `${Object.keys(validated.value.providers).length} provider(s)`,
		patchPreview: "",
	};
}

function applyPathEdit(
	content: string,
	path: (string | number)[],
	value: unknown,
): { ok: true; content: string } | { ok: false; error: string } {
	const edits = modify(content, path, value, { formattingOptions: FORMATTING, isArrayInsertion: false });
	if (edits.length === 0 && value !== undefined) {
		// No-op when value already equals — still ok
		return { ok: true, content };
	}
	const next = applyEdits(content, edits);
	const parsed = parseModelsJsoncContent(next);
	if (!parsed.ok) return parsed;
	return { ok: true, content: next };
}

function compactDiff(before: string, after: string, maxLines = 40): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const lines: string[] = [];
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i++) {
		if (a[i] === b[i]) continue;
		if (a[i] !== undefined && b[i] === undefined) lines.push(`- ${a[i]}`);
		else if (a[i] === undefined && b[i] !== undefined) lines.push(`+ ${b[i]}`);
		else {
			lines.push(`- ${a[i]}`);
			lines.push(`+ ${b[i]}`);
		}
		if (lines.length >= maxLines) {
			lines.push("…");
			break;
		}
	}
	return lines.join("\n") || "(no textual diff)";
}

function finish(before: string, after: string, summary: string): ModelsJsoncMutationResult {
	const parsed = parseModelsJsoncContent(after);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		content: after,
		document: parsed.document,
		summary,
		patchPreview: compactDiff(before, after),
	};
}

export function upsertProvider(
	content: string,
	providerId: string,
	provider: ModelsJsonProvider,
	options: { replace?: boolean } = {},
): ModelsJsoncMutationResult {
	const current = parseModelsJsoncContent(content);
	if (!current.ok) return current;
	const exists = Object.hasOwn(current.document.providers, providerId);
	if (exists && !options.replace) {
		return { ok: false, error: `Provider "${providerId}" already exists. Choose merge, edit, or replace.` };
	}
	const edited = applyPathEdit(content, ["providers", providerId], provider);
	if (!edited.ok) return edited;
	return finish(content, edited.content, exists ? `Replaced provider ${providerId}` : `Added provider ${providerId}`);
}

export function mergeProviderModels(
	content: string,
	providerId: string,
	models: ModelsJsonModel[],
): ModelsJsoncMutationResult {
	const current = parseModelsJsoncContent(content);
	if (!current.ok) return current;
	const existing = current.document.providers[providerId];
	if (!existing) return { ok: false, error: `Provider "${providerId}" not found` };

	const nextModels = [...(existing.models ?? [])];
	for (const model of models) {
		if (nextModels.some((m) => m.id === model.id)) {
			return { ok: false, error: `Model "${providerId}/${model.id}" already exists` };
		}
		nextModels.push(model);
	}
	const edited = applyPathEdit(content, ["providers", providerId, "models"], nextModels);
	if (!edited.ok) return edited;
	return finish(content, edited.content, `Added ${models.map((m) => m.id).join(", ")} to provider ${providerId}`);
}

export function addModelToProvider(
	content: string,
	providerId: string,
	model: ModelsJsonModel,
): ModelsJsoncMutationResult {
	return mergeProviderModels(content, providerId, [model]);
}

export function setProviderField(
	content: string,
	providerId: string,
	field: keyof ModelsJsonProvider,
	value: unknown,
): ModelsJsoncMutationResult {
	const current = parseModelsJsoncContent(content);
	if (!current.ok) return current;
	if (!current.document.providers[providerId]) {
		return { ok: false, error: `Provider "${providerId}" not found` };
	}
	const edited = applyPathEdit(content, ["providers", providerId, field], value);
	if (!edited.ok) return edited;
	return finish(content, edited.content, `Updated ${providerId}.${String(field)}`);
}

export function updateModelInProvider(
	content: string,
	providerId: string,
	modelId: string,
	patch: Partial<ModelsJsonModel>,
): ModelsJsoncMutationResult {
	const current = parseModelsJsoncContent(content);
	if (!current.ok) return current;
	const provider = current.document.providers[providerId];
	if (!provider) return { ok: false, error: `Provider "${providerId}" not found` };
	const models = [...(provider.models ?? [])];
	const index = models.findIndex((m) => m.id === modelId);
	if (index < 0) return { ok: false, error: `Model "${providerId}/${modelId}" not found` };
	models[index] = { ...models[index], ...patch, id: modelId };
	const edited = applyPathEdit(content, ["providers", providerId, "models"], models);
	if (!edited.ok) return edited;
	return finish(content, edited.content, `Updated model ${providerId}/${modelId}`);
}

export function removeProvider(content: string, providerId: string): ModelsJsoncMutationResult {
	const current = parseModelsJsoncContent(content);
	if (!current.ok) return current;
	if (!current.document.providers[providerId]) {
		return { ok: false, error: `Provider "${providerId}" not found` };
	}
	const edited = applyPathEdit(content, ["providers", providerId], undefined);
	if (!edited.ok) return edited;
	return finish(content, edited.content, `Removed provider ${providerId}`);
}

export function removeModelFromProvider(
	content: string,
	providerId: string,
	modelId: string,
): ModelsJsoncMutationResult {
	const current = parseModelsJsoncContent(content);
	if (!current.ok) return current;
	const provider = current.document.providers[providerId];
	if (!provider) return { ok: false, error: `Provider "${providerId}" not found` };
	const models = provider.models ?? [];
	if (!models.some((m) => m.id === modelId)) {
		return { ok: false, error: `Model "${providerId}/${modelId}" not found` };
	}
	const next = models.filter((m) => m.id !== modelId);
	const edited = applyPathEdit(content, ["providers", providerId, "models"], next);
	if (!edited.ok) return edited;
	return finish(content, edited.content, `Removed model ${providerId}/${modelId}`);
}

/**
 * Validate proposed content, write via temp file + atomic rename.
 * Caller must reload ModelRegistry after success.
 */
export async function atomicWriteModelsJsonc(
	path: string,
	content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const validated = parseModelsJsoncContent(content);
	if (!validated.ok) return validated;

	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.models.json.${process.pid}.${Date.now()}.tmp`);
	try {
		await writeFile(tmp, content, "utf-8");
		await rename(tmp, path);
		return { ok: true };
	} catch (error) {
		try {
			await writeFile(tmp, ""); // best-effort cleanup ignored
		} catch {
			/* ignore */
		}
		return {
			ok: false,
			error: `Failed to write models.json: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
