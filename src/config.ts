import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEstimators, type EstimatorOverride, type EstimatorRule } from "./estimates.ts";

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

export type UsagePeriodKind = "calendar-day" | "calendar-month" | "rolling-days";

/**
 * A credential's active usage period: the window its local attempt count is
 * measured over. `days` is required for `rolling-days` and rejected for the
 * calendar kinds. An absent period means the free-tier default, calendar-month.
 */
export interface UsagePeriod {
	kind: UsagePeriodKind;
	days?: number;
}

export interface CredentialDeclaration {
	alias: string;
	env: string;
	/**
	 * Optional usage-period/reset definition. When absent the credential's active
	 * usage period is calendar-month (the free-tier default); selection resolves
	 * that via DEFAULT_USAGE_PERIOD in ./selection.ts.
	 */
	period?: UsagePeriod;
	/**
	 * Optional per-period local warning threshold: the number of Provider Attempts
	 * in the credential's active usage period at which routing demotes it and the
	 * control plane warns. It is an attempt count, never a cost. Absent means no
	 * threshold behaviour at all for this credential.
	 */
	threshold?: number;
}

export interface SearchControlConfig {
	defaultProfile: string;
	profiles: Record<string, SearchProfile>;
	credentials: Record<Provider, CredentialDeclaration[]>;
	estimates: Record<Provider, EstimatorRule>;
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
	// A missing credentials block degrades to "every credential unavailable"
	// rather than a load failure, so the extension still loads with no credentials.
	if (value === undefined) {
		return { exa: [], tavily: [], brave: [] };
	}
	if (!isRecord(value)) {
		throw new Error(`Invalid credentials in ${sourcePath}: expected an object keyed by provider.`);
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
			const period = normalizePeriod(declaration.period, alias, key, sourcePath);
			const threshold = normalizeThreshold(declaration.threshold, alias, key, sourcePath);
			const normalized: CredentialDeclaration = { alias, env };
			if (period !== undefined) normalized.period = period;
			if (threshold !== undefined) normalized.threshold = threshold;
			credentials[key].push(normalized);
		}
	}

	return credentials;
}

function normalizePeriod(
	value: unknown,
	alias: string,
	provider: Provider,
	sourcePath: string,
): UsagePeriod | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(
			`Invalid period for credential "${alias}" in credentials.${provider} in ${sourcePath}: ` +
			'expected an object with kind "calendar-day", "calendar-month", or "rolling-days".'
		);
	}
	const kind = value.kind;
	if (kind !== "calendar-day" && kind !== "calendar-month" && kind !== "rolling-days") {
		throw new Error(
			`Invalid period.kind for credential "${alias}" in credentials.${provider} in ${sourcePath}: ` +
			'expected "calendar-day", "calendar-month", or "rolling-days".'
		);
	}
	if (kind === "rolling-days") {
		const days = value.days;
		if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
			throw new Error(
				`Invalid period.days for credential "${alias}" in credentials.${provider} in ${sourcePath}: ` +
				'"rolling-days" requires a finite integer >= 1.'
			);
		}
		return { kind, days };
	}
	if (value.days !== undefined) {
		throw new Error(
			`Invalid period.days for credential "${alias}" in credentials.${provider} in ${sourcePath}: ` +
			'only "rolling-days" may declare days.'
		);
	}
	return { kind };
}

function normalizeThreshold(
	value: unknown,
	alias: string,
	provider: Provider,
	sourcePath: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
		throw new Error(
			`Invalid threshold for credential "${alias}" in credentials.${provider} in ${sourcePath}: ` +
			"expected a finite integer >= 1."
		);
	}
	return value;
}

function normalizeEstimates(value: unknown, sourcePath: string): Record<Provider, EstimatorRule> {
	if (value === undefined) return resolveEstimators();
	if (!isRecord(value)) {
		throw new Error(`Invalid estimates in ${sourcePath}: expected an object keyed by provider.`);
	}
	const overrides: Partial<Record<Provider, EstimatorOverride>> = {};
	for (const key of Object.keys(value)) {
		if (!isProvider(key)) {
			throw new Error(
				`Unknown provider "${key}" in estimates in ${sourcePath}: expected exa, tavily, or brave.`
			);
		}
		const raw = value[key];
		if (!isRecord(raw)) {
			throw new Error(`Invalid estimates.${key} in ${sourcePath}: expected an object of rule overrides.`);
		}
		const override: EstimatorOverride = {};
		for (const field of ["version", "date", "unit", "basis"] as const) {
			const fieldValue = raw[field];
			if (fieldValue === undefined) continue;
			if (typeof fieldValue !== "string" || fieldValue.trim() === "") {
				throw new Error(
					`Invalid estimates.${key}.${field} in ${sourcePath}: expected a non-empty string.`
				);
			}
			override[field] = fieldValue.trim();
		}
		for (const field of ["unitsPerAttempt", "costPerUnitUsd"] as const) {
			const fieldValue = raw[field];
			if (fieldValue === undefined) continue;
			if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) {
				throw new Error(
					`Invalid estimates.${key}.${field} in ${sourcePath}: expected a non-negative number.`
				);
			}
			override[field] = fieldValue;
		}
		overrides[key] = override;
	}
	return resolveEstimators(overrides);
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
		estimates: normalizeEstimates(raw.estimates, sourcePath),
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