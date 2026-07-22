/**
 * Shared provider/model id rules for /models command addressing.
 */

const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_MODEL_ID_LENGTH = 128;

export type IdValidationResult = { ok: true; id: string } | { ok: false; error: string };

function validateId(raw: string, kind: "Provider" | "Model", maxLength: number): IdValidationResult {
	const id = raw.trim();
	if (!id) return { ok: false, error: `${kind} id is required` };
	if (/\s/.test(id)) return { ok: false, error: `${kind} id must not contain whitespace` };
	if (id.includes("/")) {
		return {
			ok: false,
			error:
				kind === "Provider"
					? "Provider id must not contain '/'"
					: "Model id must not contain '/' (use provider/model addressing instead)",
		};
	}
	if (id.length > maxLength) {
		return { ok: false, error: `${kind} id must be at most ${maxLength} characters` };
	}
	return { ok: true, id };
}

export function validateProviderId(raw: string): IdValidationResult {
	return validateId(raw, "Provider", MAX_PROVIDER_ID_LENGTH);
}

export function validateModelId(raw: string): IdValidationResult {
	return validateId(raw, "Model", MAX_MODEL_ID_LENGTH);
}
