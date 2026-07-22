import type {
	AutocompleteItem,
	SlashCategoryDefinition,
	SlashCommand,
	SlashCommandSourceKind,
} from "@earendil-works/pi-tui";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.ts";

export type CommandCatalogCategoryId =
	| "start"
	| "work"
	| "session"
	| "integrations"
	| "configure"
	| "share"
	| "help"
	| "templates"
	| "skills"
	| "extensions";

export interface CommandCatalogEntry {
	name: string;
	description?: string;
	argumentHint?: string;
	category: CommandCatalogCategoryId;
	sourceKind: SlashCommandSourceKind;
	aliases?: string[];
	priority?: number;
	hidden?: boolean;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}

export const SLASH_CATEGORIES: ReadonlyArray<SlashCategoryDefinition> = [
	{ id: "start", label: "Start or continue", order: 10 },
	{ id: "work", label: "Work", order: 20 },
	{ id: "session", label: "Session", order: 30 },
	{ id: "integrations", label: "Integrations", order: 40 },
	{ id: "configure", label: "Configure", order: 50 },
	{ id: "share", label: "Import export and sharing", order: 60 },
	{ id: "help", label: "Help", order: 70 },
	{ id: "templates", label: "Templates", order: 80, collapsed: true },
	{ id: "skills", label: "Skills", order: 90, collapsed: true },
	{ id: "extensions", label: "Extensions", order: 100, collapsed: true },
];

/** Built-in interactive commands → category map (canonical names unchanged). */
const BUILTIN_CATEGORY: Record<string, CommandCatalogCategoryId> = {
	plan: "start",
	goal: "start",
	workflow: "start",
	todos: "work",
	todo: "work",
	tasks: "work",
	task: "work",
	jobs: "work",
	ask: "work",
	btw: "work",
	new: "session",
	resume: "session",
	fork: "session",
	clone: "session",
	tree: "session",
	name: "session",
	session: "session",
	compact: "session",
	mcp: "integrations",
	llama: "integrations",
	model: "configure",
	models: "configure",
	"scoped-models": "configure",
	settings: "configure",
	login: "configure",
	logout: "configure",
	trust: "configure",
	reload: "configure",
	export: "share",
	import: "share",
	share: "share",
	copy: "share",
	hotkeys: "help",
	changelog: "help",
	quit: "help",
};

/** Qi first-party commands (registered by extensions but branded Qi). */
const QI_COMMAND_META: Record<
	string,
	{
		category: CommandCatalogCategoryId;
		hidden?: boolean;
		priority?: number;
		aliases?: string[];
	}
> = {
	plan: { category: "start", priority: 100 },
	goal: { category: "start", priority: 90 },
	workflow: { category: "start", priority: 80 },
	todos: { category: "work" },
	todo: { category: "work", priority: 50 },
	tasks: { category: "work" },
	task: { category: "work" },
	jobs: { category: "work" },
	ask: { category: "work" },
	btw: { category: "work" },
	mcp: { category: "integrations", priority: 50 },
	llama: { category: "integrations" },
	// Dev / advanced — callable but omitted from the browser
	rewind: { category: "session", hidden: true },
	cleanup: { category: "session", hidden: true },
};

const SOURCE_BADGE: Record<SlashCommandSourceKind, string | undefined> = {
	builtin: undefined,
	qi: "Qi",
	template: "template",
	skill: "skill",
	extension: "third-party",
};

export function formatSourceBadge(
	sourceKind: SlashCommandSourceKind | undefined,
	existingDescription?: string,
): string | undefined {
	const badge = sourceKind ? SOURCE_BADGE[sourceKind] : undefined;
	if (!badge) {
		return existingDescription;
	}
	const tagged = `[${badge}]`;
	if (!existingDescription) {
		return tagged;
	}
	if (existingDescription.includes(tagged)) {
		return existingDescription;
	}
	return `${tagged} ${existingDescription}`;
}

export function resolveBuiltinCategory(name: string): CommandCatalogCategoryId {
	return BUILTIN_CATEGORY[name] ?? "help";
}

export function resolveQiCommandMeta(name: string): (typeof QI_COMMAND_META)[string] | undefined {
	return QI_COMMAND_META[name];
}

export interface BuildSlashCatalogInput {
	builtins?: ReadonlyArray<{ name: string; description: string; argumentHint?: string }>;
	extensionCommands?: ReadonlyArray<{
		name: string;
		invocationName: string;
		description?: string;
		argumentHint?: string;
		category?: string;
		aliases?: string[];
		hidden?: boolean;
		priority?: number;
		getArgumentCompletions?: CommandCatalogEntry["getArgumentCompletions"];
		/** Pre-formatted description (e.g. with scope tag). */
		displayDescription?: string;
	}>;
	templates?: ReadonlyArray<{
		name: string;
		description?: string;
		argumentHint?: string;
		displayDescription?: string;
	}>;
	skills?: ReadonlyArray<{
		name: string;
		description?: string;
		displayDescription?: string;
	}>;
}

/**
 * Compose the slash command catalog used by CombinedAutocompleteProvider.
 * Unknown extension commands without an explicit category land in Extensions
 * (never inferred from command name strings).
 */
export function buildSlashCommandCatalog(input: BuildSlashCatalogInput = {}): SlashCommand[] {
	const builtins = input.builtins ?? BUILTIN_SLASH_COMMANDS;
	const byName = new Map<string, SlashCommand>();

	for (const command of builtins) {
		byName.set(command.name, {
			name: command.name,
			description: formatSourceBadge("builtin", command.description),
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
			category: resolveBuiltinCategory(command.name),
			sourceKind: "builtin",
		});
	}

	for (const command of input.extensionCommands ?? []) {
		const qiMeta = resolveQiCommandMeta(command.name);
		const explicitCategory = command.category as CommandCatalogCategoryId | undefined;
		const isQi = Boolean(qiMeta);
		const category: CommandCatalogCategoryId = explicitCategory ?? qiMeta?.category ?? "extensions";
		const sourceKind: SlashCommandSourceKind = isQi ? "qi" : "extension";
		const description = formatSourceBadge(sourceKind, command.displayDescription ?? command.description);
		const entry: SlashCommand = {
			name: command.invocationName,
			...(description ? { description } : {}),
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
			category,
			sourceKind,
			...((command.aliases ?? qiMeta?.aliases) ? { aliases: command.aliases ?? qiMeta?.aliases } : {}),
			...(command.priority !== undefined || qiMeta?.priority !== undefined
				? { priority: command.priority ?? qiMeta?.priority }
				: {}),
			hidden: command.hidden ?? qiMeta?.hidden ?? false,
			...(command.getArgumentCompletions ? { getArgumentCompletions: command.getArgumentCompletions } : {}),
		};

		// Extension/Qi commands override builtins of the same name for metadata + handlers,
		// but keep the canonical name (invocationName may differ on conflict).
		const existing = byName.get(entry.name);
		if (existing) {
			byName.set(entry.name, {
				...existing,
				...entry,
				description: entry.description ?? existing.description,
				argumentHint: entry.argumentHint ?? existing.argumentHint,
				getArgumentCompletions: entry.getArgumentCompletions ?? existing.getArgumentCompletions,
			});
		} else {
			byName.set(entry.name, entry);
		}
	}

	for (const template of input.templates ?? []) {
		const description = formatSourceBadge("template", template.displayDescription ?? template.description);
		byName.set(template.name, {
			name: template.name,
			...(description ? { description } : {}),
			...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
			category: "templates",
			sourceKind: "template",
		});
	}

	for (const skill of input.skills ?? []) {
		const commandName = skill.name.startsWith("skill:") ? skill.name : `skill:${skill.name}`;
		const description = formatSourceBadge("skill", skill.displayDescription ?? skill.description);
		byName.set(commandName, {
			name: commandName,
			...(description ? { description } : {}),
			category: "skills",
			sourceKind: "skill",
		});
	}

	return [...byName.values()];
}
