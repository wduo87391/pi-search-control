import type { Provider, ProviderMode, SearchControlConfig } from "./config.ts";
import { formatSearchMarkdown, isAbortError, keyId, shuffle, type SearchOptions, type SearchResponse } from "./utils.ts";
import { searchBrave } from "./providers/brave.ts";
import { searchExa } from "./providers/exa.ts";
import { searchTavily } from "./providers/tavily.ts";

export interface SearchTarget {
	provider: Provider;
	apiKey: string;
	keyId: string;
}

export interface RoutedSearchResult {
	query: string;
	provider: Provider;
	keyId: string;
	answer: string;
	results: SearchResponse["results"];
	markdown: string;
}

export interface FailedAttempt {
	provider: Provider;
	keyId: string;
	error: string;
}

function providerTargets(config: SearchControlConfig, provider: Provider): SearchTarget[] {
	return config.apiKeys[provider].map((apiKey) => ({
		provider,
		apiKey,
		keyId: keyId(provider, apiKey),
	}));
}

export function buildSearchPlan(config: SearchControlConfig, mode: ProviderMode = config.provider): SearchTarget[] {
	if (mode === "balanced") {
		return shuffle(config.providers.flatMap((provider) => providerTargets(config, provider)));
	}

	if (mode === "auto") {
		return config.providers.flatMap((provider) => shuffle(providerTargets(config, provider)));
	}

	return shuffle(providerTargets(config, mode));
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
	options: Partial<SearchOptions> = {},
): Promise<RoutedSearchResult & { attempts: FailedAttempt[] }> {
	const plan = buildSearchPlan(config);
	if (plan.length === 0) {
		throw new Error(
			`No API keys available for provider mode "${config.provider}". ` +
			`Check ${config.providers.map((p) => `apiKeys.${p}`).join(", ")} in ~/.pi/web-search.json.`
		);
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
				keyId: target.keyId,
				answer: response.answer,
				results: response.results,
				markdown: formatSearchMarkdown(query, target.provider, target.keyId, response),
				attempts,
			};
		} catch (err) {
			if (isAbortError(err)) throw err;
			attempts.push({ provider: target.provider, keyId: target.keyId, error: errorMessage(err) });
		}
	}

	throw new Error(
		`Search failed for all configured targets:\n` +
		attempts.map((attempt) => `- ${attempt.provider} ${attempt.keyId}: ${attempt.error}`).join("\n")
	);
}
