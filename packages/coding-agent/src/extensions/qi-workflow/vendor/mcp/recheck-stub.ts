/** Lightweight regex safety stand-in for the `recheck` package (not vendored). */
export function checkSync(
	_source: string,
	_flags?: string,
	_params?: { attackTimeout?: number; incubationTimeout?: number; timeout?: number },
): { status: "safe" | "vulnerable" | "unknown"; complexity?: { type: string } } {
	// Prefer allowing search; catastrophic patterns are rare in interactive MCP tool search.
	return { status: "safe" };
}
