import { type Provider, type SearchControlConfig, type SearchProfile } from "./config.ts";
import { resolveCredentials, type ResolvedCredential } from "./credentials.ts";
import { rankCredentials, type PenaltyState } from "./selection.ts";
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
 * Selection inputs the plan builder needs beyond the profile and resolved
 * credentials. The clock and attempt history are injected so the builder stays
 * pure: it never reads the system time, the filesystem, the network, or the
 * environment.
 */
export interface SearchPlanInput {
	/** Injected clock (ms), used to scope attempt counts to each credential's period. */
	now: number;
	/** Recorded attempt timestamps (ms) per credential alias; absent means none. */
	attemptsByAlias?: Record<string, number[]>;
	/** Health/threshold penalties per alias; absent means no penalties. */
	penalties?: Record<string, PenaltyState>;
}

function toTarget(credential: ResolvedCredential): SearchTarget {
	return { provider: credential.provider, alias: credential.alias, apiKey: credential.apiKey };
}

/**
 * Order one provider's available credentials least-used-first through the shared
 * pure selector, then map the ranked candidates back to their resolved keys.
 */
function orderProvider(candidates: ResolvedCredential[], input: SearchPlanInput): ResolvedCredential[] {
	const byAlias = new Map(candidates.map((credential) => [credential.alias, credential]));
	const ranked = rankCredentials(
		candidates.map((credential) => ({
			alias: credential.alias,
			available: credential.available,
			period: credential.period,
			attemptTimes: input.attemptsByAlias?.[credential.alias] ?? [],
		})),
		{ now: input.now, penalties: input.penalties }
	);
	return ranked.map((candidate) => byAlias.get(candidate.alias)!);
}

/**
 * Build the ordered attempt plan for a Search Profile from resolved credentials.
 * The plan follows the profile's provider order; within each provider the shared
 * selector ranks credentials least-used-first with deterministic tie-breaking,
 * excludes unavailable and cooling credentials, and demotes threshold-crossed
 * ones. The plan is identified by alias only.
 *
 * With no attempt data and no penalties the ranking collapses to the previous
 * declaration-order behaviour, so an un-wired caller does not regress.
 */
export function buildSearchPlan(
	profile: SearchProfile,
	credentials: ResolvedCredential[],
	input: SearchPlanInput
): SearchTarget[] {
	const byProvider = new Map<Provider, ResolvedCredential[]>();
	for (const credential of credentials) {
		if (!credential.available) continue;
		const candidates = byProvider.get(credential.provider) ?? [];
		candidates.push(credential);
		byProvider.set(credential.provider, candidates);
	}
	return profile.providers.flatMap((provider) =>
		orderProvider(byProvider.get(provider) ?? [], input).map(toTarget)
	);
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
	// Ticket 06 (search orchestration) injects the clock and ledger-derived
	// attempt counts here, plus real cooldown/threshold penalties. Passing none
	// keeps the previous declaration-order plan until that wiring lands.
	const plan = buildSearchPlan(profile, credentials, { now: Date.now() });
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
