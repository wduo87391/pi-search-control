import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

export const PROVIDERS = ["exa", "tavily", "brave"] as const;
export type Provider = typeof PROVIDERS[number];

export interface SearchDefaults {
	numResults: number;
	timeoutMs: number;
}

export interface FetchDefaults {
	timeoutMs: number;
	maxChars: number;
}

export interface SearchProfile {
	name: string;
	providers: Provider[];
}

export interface CredentialDeclaration {
	alias: string;
	env: string;
}

export interface SearchControlConfig {
	defaultProfile: string;
	profiles: Record<string, SearchProfile>;
	credentials: Record<Provider, CredentialDeclaration[]>;
	search: SearchDefaults;
	fetch: FetchDefaults;
}

const DEFAULT_SEARCH: SearchDefaults = { numResults: 5, timeoutMs: 20_000 };
const DEFAULT_FETCH: FetchDefaults = { timeoutMs: 20_000, maxChars: 30_000 };

const LEGACY_FIELDS = [
	"provider",
	"providers",
	"apiKeys",
	"exaApiKey",
	"exaApiKeys",
	"tavilyApiKey",
	"tavilyApiKeys",
	"braveApiKey",
	"braveApiKeys",
	"loadBalancing",
	"workflow",
	"geminiApiKey",
	"perplexityApiKey",
];

const NEW_FORMAT_HINT =
	'{ "defaultProfile": "<name>", "profiles": { "<name>": { "providers": ["exa", "tavily", "brave"] } }, ' +
	'"credentials": { "exa": [{ "alias": "<alias>", "env": "<ENV_VAR>" }] } }';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function normalizeCredentials(value: unknown, sourcePath: string): Record<Provider, CredentialDeclaration[]> {
	if (!isRecord(value)) {
		throw new Error(`Missing credentials in ${sourcePath}. Expected ${NEW_FORMAT_HINT}.`);
	}

	const credentials: Record<Provider, CredentialDeclaration[]> = { exa: [], tavily: [], brave: [] };
	const aliasOwner = new Map<string, Provider>();

	for (const key of Object.keys(value)) {
		if (!isProvider(key)) {
			throw new Error(
				`Unknown provider "${key}" in credentials in ${sourcePath}: expected exa, tavily, or brave.`
			);
		}
		const declarations = value[key];
		if (declarations === undefined) continue;
		if (!Array.isArray(declarations)) {
			throw new Error(
				`Invalid credentials.${key} in ${sourcePath}: expected an array of { alias, env } objects.`
			);
		}
		for (const declaration of declarations) {
			if (!isRecord(declaration)) {
				throw new Error(
					`Invalid credentials.${key} entry in ${sourcePath}: expected an object with alias and env.`
				);
			}
			const alias = typeof declaration.alias === "string" ? declaration.alias.trim() : "";
			if (!alias) {
				throw new Error(`Invalid credentials.${key} entry in ${sourcePath}: missing alias.`);
			}
			const env = typeof declaration.env === "string" ? declaration.env.trim() : "";
			if (!env) {
				throw new Error(
					`Invalid credentials.${key} entry for alias "${alias}" in ${sourcePath}: missing env reference.`
				);
			}
			const owner = aliasOwner.get(alias);
			if (owner !== undefined) {
				throw new Error(
					`Duplicate credential alias "${alias}" in ${sourcePath}: already declared for ${owner}.`
				);
			}
			aliasOwner.set(alias, key);
			credentials[key].push({ alias, env });
		}
	}

	return credentials;
}

function normalizeNumber(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${name} in ${CONFIG_PATH}: expected a positive number.`);
	}
	return Math.floor(value);
}

function normalizeProfileProviders(value: unknown, profileName: string, sourcePath: string): Provider[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(
			`Invalid profiles.${profileName}.providers in ${sourcePath}: ` +
			"expected a non-empty array of exa, tavily, or brave."
		);
	}
	const providers: Provider[] = [];
	for (const item of value) {
		if (!isProvider(item)) {
			throw new Error(
				`Invalid provider ${JSON.stringify(item)} in profiles.${profileName}.providers in ${sourcePath}: ` +
				"expected exa, tavily, or brave."
			);
		}
		if (!providers.includes(item)) providers.push(item);
	}
	return providers;
}

function normalizeProfiles(value: unknown, sourcePath: string): Record<string, SearchProfile> {
	if (!isRecord(value)) {
		throw new Error(`Missing profiles in ${sourcePath}. Expected ${NEW_FORMAT_HINT}.`);
	}
	const names = Object.keys(value);
	if (names.length === 0) {
		throw new Error(`Invalid profiles in ${sourcePath}: expected at least one Search Profile.`);
	}
	const profiles: Record<string, SearchProfile> = {};
	for (const name of names) {
		const raw = value[name];
		if (!isRecord(raw)) {
			throw new Error(
				`Invalid profiles.${name} in ${sourcePath}: expected an object with a providers array.`
			);
		}
		profiles[name] = {
			name,
			providers: normalizeProfileProviders(raw.providers, name, sourcePath),
		};
	}
	return profiles;
}

function normalizeDefaultProfile(
	value: unknown,
	profiles: Record<string, SearchProfile>,
	sourcePath: string,
): string {
	if (value === undefined) {
		throw new Error(
			`Missing defaultProfile in ${sourcePath}: expected the name of a Search Profile declared in profiles.`
		);
	}
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Invalid defaultProfile in ${sourcePath}: expected a non-empty string.`);
	}
	const name = value.trim();
	if (!(name in profiles)) {
		throw new Error(`Unknown defaultProfile "${name}" in ${sourcePath}: not declared in profiles.`);
	}
	return name;
}

function assertNoLegacyFields(raw: Record<string, unknown>, sourcePath: string): void {
	const found = LEGACY_FIELDS.filter((field) => field in raw);
	if (found.length > 0) {
		throw new Error(
			`${sourcePath} uses legacy fields (${found.join(", ")}). ` +
			`pi-search-control only supports the new format: ${NEW_FORMAT_HINT}.`
		);
	}
}

export function parseConfig(raw: unknown, sourcePath = CONFIG_PATH): SearchControlConfig {
	if (!isRecord(raw)) {
		throw new Error(`${sourcePath} must contain a JSON object.`);
	}

	assertNoLegacyFields(raw, sourcePath);

	const profiles = normalizeProfiles(raw.profiles, sourcePath);
	const searchRaw = isRecord(raw.search) ? raw.search : {};
	const fetchRaw = isRecord(raw.fetch) ? raw.fetch : {};

	return {
		defaultProfile: normalizeDefaultProfile(raw.defaultProfile, profiles, sourcePath),
		profiles,
		credentials: normalizeCredentials(raw.credentials, sourcePath),
		search: {
			// Respect user-configured value; provider APIs enforce their own caps.
			numResults: normalizeNumber(searchRaw.numResults, DEFAULT_SEARCH.numResults, "search.numResults"),
			timeoutMs: normalizeNumber(searchRaw.timeoutMs, DEFAULT_SEARCH.timeoutMs, "search.timeoutMs"),
		},
		fetch: {
			timeoutMs: normalizeNumber(fetchRaw.timeoutMs, DEFAULT_FETCH.timeoutMs, "fetch.timeoutMs"),
			maxChars: normalizeNumber(fetchRaw.maxChars, DEFAULT_FETCH.maxChars, "fetch.maxChars"),
		},
	};
}

export function loadConfig(): SearchControlConfig {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`Missing config file: ${CONFIG_PATH}`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	return parseConfig(raw, CONFIG_PATH);
}