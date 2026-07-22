import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function nowMs(): number {
	return Date.now();
}
