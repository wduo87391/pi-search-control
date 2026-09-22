import { type Provider, type SearchControlConfig, type SearchProfile } from "./config.ts";
import { resolveCredentials, type ResolvedCredential } from "./credentials.ts";
import { classifyError, type ErrorCategory } from "./ledger.ts";
import { formatSearchMarkdown, isAbortError, type SearchOptions, type SearchResponse } from "./utils.ts";
import { searchBrave } from "./providers/brave.ts";
import { searchExa } from "./providers/exa.ts";
import { searchTavily } from "./providers/tavily.ts";

export interface SearchTarget {
	provider: Provider;
	alias: string;
	apiKey: string;
}

export interface RoutedSearchResult {
	query: string;
	provider: Provider;
	alias: string;
	answer: string;
	results: SearchResponse["results"];
	markdown: string;
}

export interface FailedAttempt {
	provider: Provider;
	alias: string;
	error: string;
	errorCategory: ErrorCategory;
}

/**
 * Thrown when every configured target failed. It carries the structured
 * Provider Attempts so callers can account for them in the usage ledger without
 * parsing the message.
 */
export class SearchFailureError extends Error {
	readonly attempts: FailedAttempt[];

	constructor(attempts: FailedAttempt[]) {
		super(
			`Search failed for all configured targets:\n` +
			attempts.map((attempt) => `- ${attempt.provider} ${attempt.alias}: ${attempt.error}`).join("\n")
		);
		this.name = "SearchFailureError";
		this.attempts = attempts;
	}
}

/**
 * Build the ordered attempt plan for a Search Profile from resolved credentials.
 * Credentials that are unavailable in the environment are excluded so the plan
 * never reaches for a key that is not there. The plan is identified by alias only.
 */
export function buildSearchPlan(profile: SearchProfile, credentials: ResolvedCredential[]): SearchTarget[] {
	const byProvider = new Map<Provider, SearchTarget[]>();
	for (const credential of credentials) {
		if (!credential.available) continue;
		const targets = byProvider.get(credential.provider) ?? [];
		targets.push({ provider: credential.provider, alias: credential.alias, apiKey: credential.apiKey });
		byProvider.set(credential.provider, targets);
	}
	return profile.providers.flatMap((provider) => byProvider.get(provider) ?? []);
}

function noUsableCredentialsMessage(profile: SearchProfile, credentials: ResolvedCredential[]): string {
	const declared = credentials.filter((credential) => profile.providers.includes(credential.provider));
	const unavailable = declared.filter((credential) => !credential.available).map((credential) => credential.alias);
	if (unavailable.length > 0) {
		return `No available credentials for Search Profile "${profile.name}". Unavailable: ${unavailable.join(", ")}.`;
	}
	return `No credentials declared for Search Profile "${profile.name}" providers: ${profile.providers.join(", ")}.`;
}

async function searchWithTarget(target: SearchTarget, query: string, options: SearchOptions): Promise<SearchResponse> {
	if (target.provider === "exa") return searchExa(query, target.apiKey, options);
	if (target.provider === "tavily") return searchTavily(query, target.apiKey, options);
	return searchBrave(query, target.apiKey, options);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function searchOne(
	query: string,
	config: SearchControlConfig,
	profile: SearchProfile,
	options: Partial<SearchOptions> = {},
): Promise<RoutedSearchResult & { attempts: FailedAttempt[] }> {
	const credentials = resolveCredentials(config.credentials, process.env);
	const plan = buildSearchPlan(profile, credentials);
	if (plan.length === 0) {
		throw new Error(noUsableCredentialsMessage(profile, credentials));
	}

	const attempts: FailedAttempt[] = [];
	const searchOptions: SearchOptions = {
		numResults: options.numResults ?? config.search.numResults,
		timeoutMs: options.timeoutMs ?? config.search.timeoutMs,
		signal: options.signal,
	};

	for (const target of plan) {
		try {
			const response = await searchWithTarget(target, query, searchOptions);
			return {
				query,
				provider: target.provider,
				alias: target.alias,
				answer: response.answer,
				results: response.results,
				markdown: formatSearchMarkdown(query, target.provider, target.alias, response),
				attempts,
			};
		} catch (err) {
			if (isAbortError(err)) throw err;
			attempts.push({
				provider: target.provider,
				alias: target.alias,
				error: errorMessage(err),
				errorCategory: classifyError(err),
			});
		}
	}

	throw new SearchFailureError(attempts);
}
