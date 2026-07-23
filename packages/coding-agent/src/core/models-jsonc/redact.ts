/**
 * Credential / header redaction for models.json previews and diagnostics.
 * Never include raw secret values in UI, logs, or fixtures.
 */

const SECRET_KEY_RE = /^(api[_-]?key|authorization|token|secret|password|credential)$/i;
const ENV_REF_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_REF_RE = /^\$\(.+\)$/;

export type AuthReferenceKind = "env" | "command" | "literal" | "none";

export function classifyAuthReference(value: string | undefined): AuthReferenceKind {
	if (!value) return "none";
	if (ENV_REF_RE.test(value)) return "env";
	if (COMMAND_REF_RE.test(value)) return "command";
	return "literal";
}

export function authReferenceLabel(kind: AuthReferenceKind): string {
	switch (kind) {
		case "env":
			return "environment reference";
		case "command":
			return "command reference";
		case "literal":
			return "literal value (stored in models.json)";
		case "none":
			return "not set";
	}
}

/** Redact a single string that may be a secret. Env/command refs keep their shape. */
export function redactSecretValue(value: string): string {
	const kind = classifyAuthReference(value);
	if (kind === "env" || kind === "command") return value;
	if (value.length <= 4) return "••••";
	return `${value.slice(0, 2)}…${"•".repeat(Math.min(8, value.length - 2))}`;
}

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(record)) {
		if (typeof val === "string" && SECRET_KEY_RE.test(key)) {
			out[key] = redactSecretValue(val);
		} else if (typeof val === "string" && key.toLowerCase() === "apikey") {
			out[key] = redactSecretValue(val);
		} else {
			out[key] = redactSecretsDeep(val);
		}
	}
	return out;
}

/** Deep-clone and redact apiKey / secret-like fields for safe display. */
export function redactSecretsDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSecretsDeep);
	if (value && typeof value === "object") {
		return redactRecord(value as Record<string, unknown>);
	}
	return value;
}

/** Redact secrets in a JSONC/JSON text preview while preserving structure when possible. */
export function redactSecretsInText(text: string): string {
	return text
		.replace(/("apiKey"\s*:\s*")([^"]*)(")/gi, (_m, a, value, c) => `${a}${redactSecretValue(value)}${c}`)
		.replace(
			/("(?:Authorization|authorization|token|secret|password)"\s*:\s*")([^"]*)(")/g,
			(_m, a, value, c) => `${a}${redactSecretValue(value)}${c}`,
		)
		.replace(
			/("headers"\s*:\s*\{[^}]*"(?:Authorization|X-Api-Key|api[_-]?key)"\s*:\s*")([^"]*)(")/gi,
			(_m, a, value, c) => `${a}${redactSecretValue(value)}${c}`,
		);
}
