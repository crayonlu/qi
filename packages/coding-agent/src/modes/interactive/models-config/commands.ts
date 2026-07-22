/**
 * Interactive /models command family: guided provider/model configuration
 * that mutates models.json (JSONC-preserving) and reloads ModelRegistry.
 */

import { getModelsPath } from "../../../config.ts";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import {
	MODEL_PROVIDER_APIS,
	type ModelProviderApi,
	type ModelsJsonModel,
	type ModelsJsonProvider,
} from "../../../core/model-config.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import {
	addModelToProvider,
	atomicWriteModelsJsonc,
	authReferenceLabel,
	classifyAuthReference,
	type ModelsJsoncMutationResult,
	parseModelsJsoncContent,
	readModelsJsonc,
	redactSecretsInText,
	removeModelFromProvider,
	removeProvider,
	updateModelInProvider,
	upsertProvider,
} from "../../../core/models-jsonc/index.ts";

export interface ModelsConfigHost {
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
	modelRegistry: ModelRegistry;
	/** Optional current model label for status display. */
	currentModelLabel?: string;
	isBuiltinProvider?: (providerId: string) => boolean;
	getModelsPath?: () => string;
}

const PRESETS: Array<{ label: string; api: ModelProviderApi; baseUrl: string }> = [
	{ label: "OpenAI-compatible", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
	{ label: "Anthropic-compatible", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	{ label: "Custom HTTP endpoint", api: "openai-completions", baseUrl: "https://example.com/v1" },
];

function modelsPath(host: ModelsConfigHost): string {
	return host.getModelsPath?.() ?? getModelsPath();
}

async function loadContent(host: ModelsConfigHost): Promise<{ content: string; exists: boolean }> {
	return readModelsJsonc(modelsPath(host));
}

async function saveAndReload(
	host: ModelsConfigHost,
	mutation: ModelsJsoncMutationResult,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
	if (!mutation.ok) return mutation;
	const write = await atomicWriteModelsJsonc(modelsPath(host), mutation.content);
	if (!write.ok) return write;
	try {
		await host.modelRegistry.refresh();
	} catch (error) {
		return {
			ok: false,
			error: `Saved models.json but reload failed: ${error instanceof Error ? error.message : String(error)}. File was kept.`,
		};
	}
	const reloadError = host.modelRegistry.getError();
	if (reloadError) {
		return { ok: false, error: `Saved models.json but reload reported: ${reloadError}. File was kept.` };
	}
	return { ok: true, summary: mutation.summary };
}

async function showPreviewAndSave(host: ModelsConfigHost, mutation: ModelsJsoncMutationResult): Promise<boolean> {
	if (!mutation.ok) {
		host.ui.notify(mutation.error, "error");
		return false;
	}
	const preview = redactSecretsInText(mutation.patchPreview);
	const summary = [mutation.summary, "", "Patch (secrets redacted):", preview].join("\n");
	return host.ui.confirm("Save models.json change?", summary);
}

async function promptCredential(host: ModelsConfigHost): Promise<string | undefined> {
	const mode = await host.ui.select("Credential mode", [
		"Environment variable reference (recommended)",
		"Command reference",
		"Literal value (written to models.json)",
		"Skip / no apiKey",
	]);
	if (!mode || mode.startsWith("Skip")) return undefined;

	if (mode.startsWith("Environment")) {
		const name = await host.ui.input("Environment variable name", "MY_PROVIDER_API_KEY");
		if (!name?.trim()) return undefined;
		const cleaned = name.trim().replace(/^\$/, "");
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleaned)) {
			host.ui.notify("Invalid environment variable name", "error");
			return undefined;
		}
		return `$${cleaned}`;
	}

	if (mode.startsWith("Command")) {
		const cmd = await host.ui.input("Command that prints the API key", "op read op://…");
		if (!cmd?.trim()) return undefined;
		return `$(${cmd.trim()})`;
	}

	const warned = await host.ui.confirm(
		"Literal API key",
		"The literal value will be written into models.json on disk. Prefer an environment reference. Continue?",
	);
	if (!warned) return undefined;
	const literal = await host.ui.input("API key (will be stored in models.json)", "");
	return literal?.trim() || undefined;
}

async function promptModelBasics(host: ModelsConfigHost): Promise<ModelsJsonModel | undefined> {
	const id = await host.ui.input("Model id", "my-model");
	if (!id?.trim()) {
		host.ui.notify("Model id is required", "error");
		return undefined;
	}
	const name = await host.ui.input("Display name (optional)", id.trim());
	const reasoning = await host.ui.select("Reasoning model?", ["No", "Yes"]);
	const inputMode = await host.ui.select("Input modalities", ["text", "text + image"]);
	const model: ModelsJsonModel = {
		id: id.trim(),
		...(name?.trim() ? { name: name.trim() } : {}),
		reasoning: reasoning === "Yes",
		input: inputMode === "text + image" ? ["text", "image"] : ["text"],
	};

	const advanced = await host.ui.select("Advanced model fields?", ["Skip", "Configure context/maxTokens/cost"]);
	if (advanced?.startsWith("Configure")) {
		const ctx = await host.ui.input("Context window (optional number)", "128000");
		const maxTokens = await host.ui.input("Max tokens (optional number)", "8192");
		const nCtx = Number(ctx);
		const nMax = Number(maxTokens);
		if (Number.isFinite(nCtx) && nCtx > 0) model.contextWindow = nCtx;
		if (Number.isFinite(nMax) && nMax > 0) model.maxTokens = nMax;
		const costIn = await host.ui.input("Cost input (optional)", "0");
		const costOut = await host.ui.input("Cost output (optional)", "0");
		const ci = Number(costIn);
		const co = Number(costOut);
		if (Number.isFinite(ci) && Number.isFinite(co)) {
			model.cost = { input: ci, output: co, cacheRead: 0, cacheWrite: 0 };
		}
	}
	return model;
}

async function runCreateProviderWizard(
	host: ModelsConfigHost,
	presetHint?: { label: string; api: ModelProviderApi; baseUrl: string },
): Promise<void> {
	let api: ModelProviderApi = presetHint?.api ?? "openai-completions";
	let baseUrl = presetHint?.baseUrl ?? "";

	if (!presetHint) {
		const presetLabel = await host.ui.select("Provider template", [
			...PRESETS.map((p) => p.label),
			"Choose API dialect manually",
		]);
		if (!presetLabel) return;

		const preset = PRESETS.find((p) => p.label === presetLabel);
		api = preset?.api ?? "openai-completions";
		baseUrl = preset?.baseUrl ?? "";

		if (!preset) {
			const apiChoice = await host.ui.select("API dialect", [...MODEL_PROVIDER_APIS]);
			if (!apiChoice) return;
			api = apiChoice as ModelProviderApi;
		}
	}

	const providerId = await host.ui.input("Provider id", "my-provider");
	if (!providerId?.trim()) {
		host.ui.notify("Provider id is required", "error");
		return;
	}
	const id = providerId.trim();

	const displayName = await host.ui.input("Display name (optional)", id);
	if (!baseUrl) {
		baseUrl = (await host.ui.input("Base URL / endpoint", "https://example.com/v1"))?.trim() ?? "";
	} else {
		const edited = await host.ui.input("Base URL / endpoint", baseUrl);
		if (edited?.trim()) baseUrl = edited.trim();
	}
	if (!baseUrl) {
		host.ui.notify("Base URL is required", "error");
		return;
	}

	const apiKey = await promptCredential(host);
	const model = await promptModelBasics(host);
	if (!model) return;

	const provider: ModelsJsonProvider = {
		...(displayName?.trim() ? { name: displayName.trim() } : {}),
		api,
		baseUrl,
		...(apiKey ? { apiKey } : {}),
		models: [model],
	};

	const { content } = await loadContent(host);
	const mutation = upsertProvider(content, id, provider);
	if (!(await showPreviewAndSave(host, mutation))) return;
	if (!mutation.ok) return;

	const saved = await saveAndReload(host, mutation);
	if (!saved.ok) {
		host.ui.notify(saved.error, "error");
		return;
	}

	host.ui.notify(
		`Configured ${id}/${model.id}. Auth: ${authReferenceLabel(classifyAuthReference(apiKey))}. Use /model to select it.`,
		"info",
	);

	const switchNow = await host.ui.confirm("Switch model?", `Switch to ${id}/${model.id} now?`);
	if (switchNow) {
		const found = host.modelRegistry.find(id, model.id);
		if (!found) {
			host.ui.notify("Model not found after reload", "error");
			return;
		}
		// Caller (interactive-mode) switches via session.setModel when offered through notify only —
		// return path uses confirm; interactive wrapper handles setModel.
		(host as ModelsConfigHost & { pendingSwitch?: { provider: string; model: string } }).pendingSwitch = {
			provider: id,
			model: model.id,
		};
	}
}

async function runAddModelToExistingWizard(host: ModelsConfigHost): Promise<void> {
	const { content } = await loadContent(host);
	const parsed = parseModelsJsoncContent(content);
	if (!parsed.ok) {
		host.ui.notify(parsed.error, "error");
		return;
	}
	const ids = Object.keys(parsed.document.providers);
	if (ids.length === 0) {
		host.ui.notify("No providers in models.json. Create a custom provider first.", "warning");
		return;
	}
	const providerId = await host.ui.select("Existing provider", ids);
	if (!providerId) return;

	if (host.isBuiltinProvider?.(providerId)) {
		const ok = await host.ui.confirm(
			"Built-in provider warning",
			`Adding models under built-in provider "${providerId}" in models.json replaces that provider's catalog for this agent. Continue?`,
		);
		if (!ok) return;
	}

	const model = await promptModelBasics(host);
	if (!model) return;

	const mutation = addModelToProvider(content, providerId, model);
	if (!(await showPreviewAndSave(host, mutation))) return;
	const saved = await saveAndReload(host, mutation);
	if (!saved.ok) {
		host.ui.notify(saved.error, "error");
		return;
	}
	host.ui.notify(`Added ${providerId}/${model.id}. Use /model to select it.`, "info");
	(host as ModelsConfigHost & { pendingSwitch?: { provider: string; model: string } }).pendingSwitch = {
		provider: providerId,
		model: model.id,
	};
}

/** Guided /models add wizard. */
export async function runModelsAddWizard(host: ModelsConfigHost): Promise<{
	pendingSwitch?: { provider: string; model: string };
}> {
	const choice = await host.ui.select("Add model configuration", [
		"Use existing provider",
		"Create new custom provider",
		...PRESETS.map((p) => `Template: ${p.label}`),
		"Cancel",
	]);
	if (!choice || choice === "Cancel") return {};

	if (choice === "Use existing provider") {
		await runAddModelToExistingWizard(host);
	} else if (choice.startsWith("Template:")) {
		const preset = PRESETS.find((p) => choice === `Template: ${p.label}`);
		await runCreateProviderWizard(host, preset);
	} else if (choice === "Create new custom provider") {
		await runCreateProviderWizard(host);
	}
	return {
		pendingSwitch: (host as ModelsConfigHost & { pendingSwitch?: { provider: string; model: string } }).pendingSwitch,
	};
}

export async function runModelsValidate(host: ModelsConfigHost): Promise<void> {
	const { content, exists } = await loadContent(host);
	if (!exists) {
		host.ui.notify(`No models.json yet at ${modelsPath(host)} (valid empty state).`, "info");
		return;
	}
	const parsed = parseModelsJsoncContent(content);
	if (!parsed.ok) {
		host.ui.notify(parsed.error, "error");
		return;
	}
	const lines = Object.entries(parsed.document.providers).map(([id, p]) => {
		const auth = authReferenceLabel(classifyAuthReference(p.apiKey));
		const models = (p.models ?? []).map((m) => m.id).join(", ") || "(no models)";
		return `${id}: auth=${auth}; models=${models}`;
	});
	host.ui.notify(
		[
			`models.json OK (${lines.length} provider(s))`,
			...lines,
			host.currentModelLabel ? `Current: ${host.currentModelLabel}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		"info",
	);
}

export async function runModelsReload(host: ModelsConfigHost): Promise<void> {
	try {
		await host.modelRegistry.refresh();
	} catch (error) {
		host.ui.notify(`Reload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const err = host.modelRegistry.getError();
	if (err) {
		host.ui.notify(`Reload reported error: ${err}`, "error");
		return;
	}
	host.ui.notify("Reloaded models.json into the current session.", "info");
}

export async function runModelsRemoveProvider(host: ModelsConfigHost, providerId: string): Promise<void> {
	const { content } = await loadContent(host);
	const mutation = removeProvider(content, providerId);
	if (!(await showPreviewAndSave(host, mutation))) return;
	const saved = await saveAndReload(host, mutation);
	host.ui.notify(saved.ok ? saved.summary : saved.error, saved.ok ? "info" : "error");
}

export async function runModelsRemoveModel(host: ModelsConfigHost, providerId: string, modelId: string): Promise<void> {
	const { content } = await loadContent(host);
	const mutation = removeModelFromProvider(content, providerId, modelId);
	if (!(await showPreviewAndSave(host, mutation))) return;
	const saved = await saveAndReload(host, mutation);
	host.ui.notify(saved.ok ? saved.summary : saved.error, saved.ok ? "info" : "error");
}

export async function runModelsAddModelFastPath(host: ModelsConfigHost, providerId: string): Promise<void> {
	const { content } = await loadContent(host);
	const parsed = parseModelsJsoncContent(content);
	if (!parsed.ok) {
		host.ui.notify(parsed.error, "error");
		return;
	}
	if (!parsed.document.providers[providerId]) {
		host.ui.notify(`Provider "${providerId}" not found in models.json`, "error");
		return;
	}
	if (host.isBuiltinProvider?.(providerId)) {
		const ok = await host.ui.confirm(
			"Built-in provider warning",
			`Adding models under built-in provider "${providerId}" replaces that provider's catalog. Continue?`,
		);
		if (!ok) return;
	}
	const model = await promptModelBasics(host);
	if (!model) return;
	const mutation = addModelToProvider(content, providerId, model);
	if (!(await showPreviewAndSave(host, mutation))) return;
	const saved = await saveAndReload(host, mutation);
	host.ui.notify(saved.ok ? `${saved.summary}. Use /model to select it.` : saved.error, saved.ok ? "info" : "error");
}

export async function runModelsEditProvider(host: ModelsConfigHost, providerId: string): Promise<void> {
	const { content } = await loadContent(host);
	const parsed = parseModelsJsoncContent(content);
	if (!parsed.ok) {
		host.ui.notify(parsed.error, "error");
		return;
	}
	const provider = parsed.document.providers[providerId];
	if (!provider) {
		host.ui.notify(`Provider "${providerId}" not found`, "error");
		return;
	}
	const field = await host.ui.select(`Edit ${providerId}`, [
		"baseUrl",
		"name",
		"api",
		"apiKey (credential)",
		"Cancel",
	]);
	if (!field || field === "Cancel") return;

	let next: ModelsJsonProvider = { ...provider };
	if (field === "baseUrl") {
		const v = await host.ui.input("Base URL", provider.baseUrl ?? "");
		if (!v?.trim()) return;
		next = { ...next, baseUrl: v.trim() };
	} else if (field === "name") {
		const v = await host.ui.input("Display name", provider.name ?? providerId);
		if (!v?.trim()) return;
		next = { ...next, name: v.trim() };
	} else if (field === "api") {
		const v = await host.ui.select("API dialect", [...MODEL_PROVIDER_APIS]);
		if (!v) return;
		next = { ...next, api: v };
	} else if (field.startsWith("apiKey")) {
		const v = await promptCredential(host);
		if (v === undefined) return;
		next = { ...next, apiKey: v };
	}

	const mutation = upsertProvider(content, providerId, next, { replace: true });
	if (!(await showPreviewAndSave(host, mutation))) return;
	const saved = await saveAndReload(host, mutation);
	host.ui.notify(saved.ok ? saved.summary : saved.error, saved.ok ? "info" : "error");
}

export async function runModelsEditModel(host: ModelsConfigHost, providerId: string, modelId: string): Promise<void> {
	const { content } = await loadContent(host);
	const name = await host.ui.input("New display name (optional, empty skips)", "");
	const patch: Partial<ModelsJsonModel> = {};
	if (name?.trim()) patch.name = name.trim();
	const reasoning = await host.ui.select("Reasoning?", ["Keep", "Yes", "No"]);
	if (reasoning === "Yes") patch.reasoning = true;
	if (reasoning === "No") patch.reasoning = false;
	const mutation = updateModelInProvider(content, providerId, modelId, patch);
	if (!(await showPreviewAndSave(host, mutation))) return;
	const saved = await saveAndReload(host, mutation);
	host.ui.notify(saved.ok ? saved.summary : saved.error, saved.ok ? "info" : "error");
}

/** Root /models panel via select menus (works on narrow + normal terminals). */
export async function runModelsPanel(host: ModelsConfigHost): Promise<{
	pendingSwitch?: { provider: string; model: string };
}> {
	const { content, exists } = await loadContent(host);
	const parsed = exists ? parseModelsJsoncContent(content) : null;
	const providerLines = parsed?.ok
		? Object.entries(parsed.document.providers).map(([id, p]) => {
				const auth = authReferenceLabel(classifyAuthReference(p.apiKey));
				return `${id} · ${auth} · ${(p.models ?? []).length} model(s)`;
			})
		: [];

	const action = await host.ui.select("Model Provider configuration", [
		"Add (guided wizard)",
		"Validate models.json",
		"Reload registry",
		...(providerLines.length > 0 ? ["Edit provider…", "Remove provider…", "Remove model…"] : []),
		"Cancel",
	]);
	if (!action || action === "Cancel") return {};

	if (action.startsWith("Add")) return runModelsAddWizard(host);
	if (action.startsWith("Validate")) {
		await runModelsValidate(host);
		return {};
	}
	if (action.startsWith("Reload")) {
		await runModelsReload(host);
		return {};
	}
	if (action.startsWith("Edit")) {
		const ids = parsed?.ok ? Object.keys(parsed.document.providers) : [];
		const id = await host.ui.select("Provider to edit", ids);
		if (id) await runModelsEditProvider(host, id);
		return {};
	}
	if (action === "Remove provider…") {
		const ids = parsed?.ok ? Object.keys(parsed.document.providers) : [];
		const id = await host.ui.select("Provider to remove", ids);
		if (id) await runModelsRemoveProvider(host, id);
		return {};
	}
	if (action === "Remove model…") {
		const refs = parsed?.ok
			? Object.entries(parsed.document.providers).flatMap(([pid, p]) =>
					(p.models ?? []).map((m) => `${pid}/${m.id}`),
				)
			: [];
		const ref = await host.ui.select("Model to remove", refs);
		if (ref) {
			const [pid, mid] = ref.split("/");
			if (pid && mid) await runModelsRemoveModel(host, pid, mid);
		}
		return {};
	}
	return {};
}

export function parseProviderModelRef(ref: string): { provider: string; model: string } | undefined {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) return undefined;
	return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}
