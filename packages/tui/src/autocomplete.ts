import { spawn } from "child_process";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fuzzyFilter } from "./fuzzy.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = '"';
	return `${openQuote}${path}${closeQuote}`;
}

// Use fd to walk directory tree (fast, respects .gitignore)
async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}

	return await new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;

		const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish([]);
		});
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}

			const lines = stdout.trim().split("\n").filter(Boolean);
			const results: Array<{ path: string; isDirectory: boolean }> = [];

			for (const line of lines) {
				const displayLine = toDisplayPath(line);
				const hasTrailingSeparator = displayLine.endsWith("/");
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
					continue;
				}

				results.push({
					path: displayLine,
					isDirectory: hasTrailingSeparator,
				});
			}

			finish(results);
		});
	});
}

export type SlashCommandSourceKind = "builtin" | "qi" | "template" | "skill" | "extension";

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	/** When false, keyboard navigation skips this row (e.g. category headers). Default true. */
	selectable?: boolean;
	isHeader?: boolean;
	/** Category/group drill-in row (not a command completion). */
	isGroup?: boolean;
	groupId?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	category?: string;
	sourceKind?: SlashCommandSourceKind;
	aliases?: string[];
	priority?: number;
	/** Callable when typed, but omitted from the slash browser. */
	hidden?: boolean;
	isHeader?: boolean;
	isGroup?: boolean;
	groupId?: string;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface SlashCategoryDefinition {
	id: string;
	label: string;
	/** Collapsed count tile on empty root (Templates / Skills / Extensions). */
	collapsed?: boolean;
	order?: number;
}

export interface AutocompleteContextHints {
	preferredCategories?: string[];
}

export interface CombinedAutocompleteOptions {
	/** Enable category landing + drill-in when commands declare category metadata. */
	categorized?: boolean;
	categories?: SlashCategoryDefinition[];
	contextHints?: () => AutocompleteContextHints | undefined;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // What we're matching against (e.g., "/" or "src/")
}

export interface AutocompleteApplyResult {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
	/** Keep the autocomplete picker open (category/group drill-in). */
	keepOpen?: boolean;
}

export interface AutocompleteProvider {
	/** Characters that should naturally trigger this provider at token boundaries. */
	triggerCharacters?: string[];

	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	// Apply the selected item
	// Returns the new text and cursor position
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): AutocompleteApplyResult;

	// Check if file completion should trigger for explicit Tab completion
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;

	/**
	 * Pop category/group drill-in. Returns true if handled (caller should refresh
	 * suggestions instead of closing autocomplete).
	 */
	handleBack?(): boolean;
}

const HEADER_VALUE_PREFIX = "__header__:";
const GROUP_VALUE_PREFIX = "__group__:";

function isSlashCommandEntry(cmd: SlashCommand | AutocompleteItem): cmd is SlashCommand {
	return "name" in cmd;
}

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	protected commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;
	private categorized: boolean;
	private categories: SlashCategoryDefinition[];
	private contextHints?: () => AutocompleteContextHints | undefined;
	/** Drill-in category/group id while query is empty. */
	private selectedGroupId: string | null = null;

	constructor(
		commands: (SlashCommand | AutocompleteItem)[] = [],
		basePath: string,
		fdPath: string | null = null,
		options: CombinedAutocompleteOptions = {},
	) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
		this.categorized = options.categorized ?? false;
		this.categories = options.categories ?? [];
		this.contextHints = options.contextHints;
	}

	handleBack(): boolean {
		if (!this.categorized || !this.selectedGroupId) {
			return false;
		}
		this.selectedGroupId = null;
		return true;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				isQuotedPrefix,
				signal: options.signal,
			});
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		if (!options.force && textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				const query = textBeforeCursor.slice(1);
				const slashItems = this.getSlashCommandSuggestions(query);
				if (slashItems.length === 0) return null;

				return {
					items: slashItems,
					prefix: textBeforeCursor,
				};
			}

			// Typing arguments clears category drill-in
			this.selectedGroupId = null;

			const commandName = textBeforeCursor.slice(1, spaceIndex);
			const argumentText = textBeforeCursor.slice(spaceIndex + 1);

			const command = this.findCommand(commandName);
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			return {
				items: argumentSuggestions,
				prefix: argumentText,
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = this.getFileSuggestions(pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): AutocompleteApplyResult {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		// Category / collapsed-group drill-in: keep "/" and reopen picker
		if (item.isGroup && item.groupId) {
			this.selectedGroupId = item.groupId;
			const newLine = `${beforePrefix}/${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + 1,
				keepOpen: true,
			};
		}

		if (item.isHeader || item.selectable === false) {
			return { lines, cursorLine, cursorCol, keepOpen: true };
		}

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			this.selectedGroupId = null;
			// This is a command name completion
			const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			// Don't add space after directories so user can continue autocompleting
			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory ? "" : " ";
			const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		// Check if we're in a slash command context (beforePrefix contains "/command ")
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const isDirectory = item.label.endsWith("/");
			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		// For file paths, complete the path
		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const isDirectory = item.label.endsWith("/");
		const hasTrailingQuote = item.value.endsWith('"');
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	private findCommand(commandName: string): (SlashCommand | AutocompleteItem) | undefined {
		return this.commands.find((cmd) => {
			if (isSlashCommandEntry(cmd)) {
				if (cmd.name === commandName) return true;
				return cmd.aliases?.includes(commandName) ?? false;
			}
			return cmd.value === commandName;
		});
	}

	private visibleSlashCommands(): SlashCommand[] {
		return this.commands.filter((cmd): cmd is SlashCommand => {
			if (!isSlashCommandEntry(cmd)) return false;
			return !cmd.hidden;
		});
	}

	private categoryLabel(categoryId: string | undefined): string {
		if (!categoryId) return "";
		return this.categories.find((c) => c.id === categoryId)?.label ?? categoryId;
	}

	private commandToItem(cmd: SlashCommand): AutocompleteItem {
		const hint = cmd.argumentHint;
		const desc = cmd.description ?? "";
		const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
		return {
			value: cmd.name,
			label: cmd.name,
			...(fullDesc ? { description: fullDesc } : {}),
		};
	}

	private commandSearchText(cmd: SlashCommand): string {
		const parts = [
			cmd.name,
			...(cmd.aliases ?? []),
			cmd.description ?? "",
			cmd.argumentHint ?? "",
			cmd.category ?? "",
			this.categoryLabel(cmd.category),
		];
		return parts.filter(Boolean).join(" ");
	}

	private orderedCategories(): SlashCategoryDefinition[] {
		const preferred = this.contextHints?.()?.preferredCategories ?? [];
		const preferredSet = new Set(preferred);
		const sorted = [...this.categories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		if (preferredSet.size === 0) return sorted;

		const preferredCats = preferred
			.map((id) => sorted.find((c) => c.id === id))
			.filter((c): c is SlashCategoryDefinition => Boolean(c));
		const rest = sorted.filter((c) => !preferredSet.has(c.id));
		return [...preferredCats, ...rest];
	}

	private buildCategoryLanding(): AutocompleteItem[] {
		const commands = this.visibleSlashCommands();
		const items: AutocompleteItem[] = [];

		for (const category of this.orderedCategories()) {
			const inCategory = commands.filter((cmd) => cmd.category === category.id);
			if (category.collapsed) {
				if (inCategory.length === 0) continue;
				items.push({
					value: `${GROUP_VALUE_PREFIX}${category.id}`,
					label: `${category.label} (${inCategory.length})`,
					description: `Expand ${category.label.toLowerCase()}`,
					isGroup: true,
					groupId: category.id,
				});
				continue;
			}

			if (inCategory.length === 0) continue;
			const preview = inCategory
				.slice(0, 3)
				.map((c) => `/${c.name}`)
				.join(" · ");
			items.push({
				value: `${GROUP_VALUE_PREFIX}${category.id}`,
				label: category.label,
				description: preview || undefined,
				isGroup: true,
				groupId: category.id,
			});
		}

		return items;
	}

	private buildCategoryCommands(groupId: string): AutocompleteItem[] {
		const category = this.categories.find((c) => c.id === groupId);
		const commands = this.visibleSlashCommands()
			.filter((cmd) => cmd.category === groupId)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));

		const items: AutocompleteItem[] = [];
		if (category) {
			items.push({
				value: `${HEADER_VALUE_PREFIX}${groupId}`,
				label: category.label,
				selectable: false,
				isHeader: true,
			});
		}
		for (const cmd of commands) {
			items.push(this.commandToItem(cmd));
		}
		return items;
	}

	private buildGroupedSearchResults(query: string): AutocompleteItem[] {
		const commands = this.visibleSlashCommands();
		const matched = fuzzyFilter(commands, query, (cmd) => this.commandSearchText(cmd));

		// Also match category labels so typing a category name surfaces its commands
		const matchedCategoryIds = new Set(
			fuzzyFilter(this.categories, query, (c) => `${c.id} ${c.label}`).map((c) => c.id),
		);
		for (const cmd of commands) {
			if (cmd.category && matchedCategoryIds.has(cmd.category) && !matched.includes(cmd)) {
				matched.push(cmd);
			}
		}

		if (matched.length === 0) return [];

		const byCategory = new Map<string, SlashCommand[]>();
		const uncategorized: SlashCommand[] = [];
		for (const cmd of matched) {
			if (cmd.category) {
				const list = byCategory.get(cmd.category) ?? [];
				list.push(cmd);
				byCategory.set(cmd.category, list);
			} else {
				uncategorized.push(cmd);
			}
		}

		const items: AutocompleteItem[] = [];
		for (const category of this.orderedCategories()) {
			const list = byCategory.get(category.id);
			if (!list || list.length === 0) continue;
			items.push({
				value: `${HEADER_VALUE_PREFIX}${category.id}`,
				label: category.label,
				selectable: false,
				isHeader: true,
			});
			for (const cmd of list) {
				items.push(this.commandToItem(cmd));
			}
		}

		if (uncategorized.length > 0) {
			items.push({
				value: `${HEADER_VALUE_PREFIX}other`,
				label: "Other",
				selectable: false,
				isHeader: true,
			});
			for (const cmd of uncategorized) {
				items.push(this.commandToItem(cmd));
			}
		}

		return items;
	}

	private getSlashCommandSuggestions(query: string): AutocompleteItem[] {
		if (!this.categorized || this.categories.length === 0) {
			// Flat list (legacy / narrow providers)
			const commandItems = this.visibleSlashCommands().map((cmd) => {
				const item = this.commandToItem(cmd);
				return { ...item, name: cmd.name, searchText: this.commandSearchText(cmd) };
			});
			// Also include AutocompleteItem-only entries for backward compat
			for (const cmd of this.commands) {
				if (isSlashCommandEntry(cmd)) continue;
				commandItems.push({
					value: cmd.value,
					label: cmd.label,
					description: cmd.description,
					name: cmd.value,
					searchText: `${cmd.value} ${cmd.label} ${cmd.description ?? ""}`,
				});
			}

			return fuzzyFilter(commandItems, query, (item) => item.searchText).map((item) => ({
				value: item.value,
				label: item.label,
				...(item.description ? { description: item.description } : {}),
			}));
		}

		// Typing always does global search; empty query uses landing or drill-in
		if (query.length > 0) {
			this.selectedGroupId = null;
			return this.buildGroupedSearchResults(query);
		}

		if (this.selectedGroupId) {
			return this.buildCategoryCommands(this.selectedGroupId);
		}

		return this.buildCategoryLanding();
	}

	// Extract @ prefix for fuzzy file suggestions
	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	// Extract a path-like prefix from the text before cursor
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return empty string only after a space (not for completely empty text)
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		if (pathPrefix === "" && text.endsWith(" ")) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private resolveScopedFuzzyQuery(rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
		const normalizedQuery = toDisplayPath(rawQuery);
		const slashIndex = normalizedQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		const query = normalizedQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = join(this.basePath, displayBase);
		}

		try {
			if (!statSync(baseDir).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		const normalizedRelativePath = toDisplayPath(relativePath);
		if (displayBase === "/") {
			return `/${normalizedRelativePath}`;
		}
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	// Get file/directory suggestions for a given path prefix
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				rawPrefix === "" ||
				rawPrefix === "./" ||
				rawPrefix === "../" ||
				rawPrefix === "~" ||
				rawPrefix === "~/" ||
				rawPrefix === "/" ||
				(isAtPrefix && rawPrefix === "");

			if (isRootPrefix) {
				// Complete from specified position
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (rawPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				// Check if entry is a directory (or a symlink pointing to a directory)
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = join(searchDir, entry.name);
						isDirectory = statSync(fullPath).isDirectory();
					} catch {
						// Broken symlink or permission error - treat as file
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix;

				if (displayPrefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
					// Preserve ~/ format for home directory paths
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
					} else if (displayPrefix.startsWith("/")) {
						// Absolute path - construct properly
						const dir = dirname(displayPrefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = join(dirname(displayPrefix), name);
						// path.join normalizes away ./ prefix, preserve it
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = toDisplayPath(relativePath);
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (_e) {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	// Score an entry against the query (higher = better match)
	// isDirectory adds bonus to prioritize folders
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const fileName = basename(filePath);
		const lowerFileName = fileName.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let score = 0;

		// Exact filename match (highest)
		if (lowerFileName === lowerQuery) score = 100;
		// Filename starts with query
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		// Substring match in filename
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		// Substring match in full path
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		// Directories get a bonus to appear first
		if (isDirectory && score > 0) score += 10;

		return score;
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const entries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);
			if (options.signal.aborted) {
				return [];
			}

			const scoredEntries = entries
				.map((entry) => ({
					...entry,
					score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				.filter((entry) => entry.score > 0);

			scoredEntries.sort((a, b) => b.score - a.score);
			const topEntries = scoredEntries.slice(0, 20);

			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
