import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

export const PROVIDERS = ["exa", "tavily", "brave", "doubao"] as const;
export type Provider = typeof PROVIDERS[number];
export type ProviderMode = Provider | "auto" | "balanced";

export interface SearchDefaults {
	numResults: number;
	timeoutMs: number;
}

export interface FetchDefaults {
	timeoutMs: number;
	maxChars: number;
}

export interface WebLiteConfig {
	provider: ProviderMode;
	providers: Provider[];
	apiKeys: Record<Provider, string[]>;
	search: SearchDefaults;
	fetch: FetchDefaults;
}

const DEFAULT_PROVIDERS: Provider[] = ["exa", "tavily", "brave", "doubao"];
const DEFAULT_SEARCH: SearchDefaults = { numResults: 5, timeoutMs: 20_000 };
const DEFAULT_FETCH: FetchDefaults = { timeoutMs: 20_000, maxChars: 30_000 };

const LEGACY_FIELDS = [
	"exaApiKey",
	"exaApiKeys",
	"tavilyApiKey",
	"tavilyApiKeys",
	"braveApiKey",
	"braveApiKeys",
	"doubaoApiKey",
	"doubaoApiKeys",
	"loadBalancing",
	"workflow",
	"geminiApiKey",
	"perplexityApiKey",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function normalizeProviderMode(value: unknown): ProviderMode {
	if (value === undefined) return "auto";
	if (value === "auto" || value === "balanced" || isProvider(value)) return value;
	throw new Error(`Invalid provider in ${CONFIG_PATH}: expected auto, balanced, exa, tavily, brave, or doubao.`);
}

function normalizeProviderList(value: unknown): Provider[] {
	if (value === undefined) return DEFAULT_PROVIDERS;
	if (!Array.isArray(value)) {
		throw new Error(`Invalid providers in ${CONFIG_PATH}: expected an array like ["exa", "tavily", "brave", "doubao"].`);
	}
	const providers: Provider[] = [];
	for (const item of value) {
		if (!isProvider(item)) {
			throw new Error(`Invalid provider in providers: ${JSON.stringify(item)}. Expected exa, tavily, brave, or doubao.`);
		}
		if (!providers.includes(item)) providers.push(item);
	}
	return providers.length > 0 ? providers : DEFAULT_PROVIDERS;
}

function normalizeKeys(value: unknown, provider: Provider): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(`Invalid apiKeys.${provider} in ${CONFIG_PATH}: expected an array of strings.`);
	}
	const keys: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error(`Invalid apiKeys.${provider} entry in ${CONFIG_PATH}: expected strings only.`);
		}
		const key = item.trim();
		if (key && !keys.includes(key)) keys.push(key);
	}
	return keys;
}

function normalizeNumber(value: unknown, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${name} in ${CONFIG_PATH}: expected a positive number.`);
	}
	return Math.floor(value);
}

function assertNoLegacyFields(raw: Record<string, unknown>, sourcePath: string): void {
	const found = LEGACY_FIELDS.filter((field) => field in raw);
	if (found.length > 0) {
		throw new Error(
			`${sourcePath} uses legacy fields (${found.join(", ")}). ` +
			"pi-web-lite only supports the new format: { provider, providers, apiKeys: { exa: [], tavily: [], brave: [], doubao: [] } }."
		);
	}
}

export function parseConfig(raw: unknown, sourcePath = CONFIG_PATH): WebLiteConfig {
	if (!isRecord(raw)) {
		throw new Error(`${sourcePath} must contain a JSON object.`);
	}

	assertNoLegacyFields(raw, sourcePath);

	const apiKeysRaw = raw.apiKeys;
	if (!isRecord(apiKeysRaw)) {
		throw new Error(`Missing apiKeys in ${sourcePath}. Expected { "apiKeys": { "exa": [], "tavily": [], "brave": [], "doubao": [] } }.`);
	}

	const searchRaw = isRecord(raw.search) ? raw.search : {};
	const fetchRaw = isRecord(raw.fetch) ? raw.fetch : {};

	return {
		provider: normalizeProviderMode(raw.provider),
		providers: normalizeProviderList(raw.providers),
		apiKeys: {
			exa: normalizeKeys(apiKeysRaw.exa, "exa"),
			tavily: normalizeKeys(apiKeysRaw.tavily, "tavily"),
			brave: normalizeKeys(apiKeysRaw.brave, "brave"),
			doubao: normalizeKeys(apiKeysRaw.doubao, "doubao"),
		},
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

export function loadConfig(): WebLiteConfig {
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
