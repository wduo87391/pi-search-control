import type { SearchControlConfig, SearchProfile } from "./config.ts";
import type { ResolvedCredential } from "./credentials.ts";
import { estimateAttempt } from "./estimates.ts";
import {
	loadHealth,
	penaltiesFromHealth,
	recordCooldowns,
	type CooldownFailure,
	type HealthStore,
} from "./health.ts";
import {
	DETAIL_RETENTION_MS,
	classifyError,
	loadLedger,
	recordLedgerEvents,
	type LedgerEvent,
	type LedgerStore,
} from "./ledger.ts";
import type { PenaltyState } from "./selection.ts";
import {
	SearchFailureError,
	buildSearchPlan,
	noUsableCredentialsMessage,
	type FailedAttempt,
	type RoutedSearchResult,
	type SearchTarget,
} from "./search.ts";
import { formatSearchMarkdown, isAbortError, type SearchOptions, type SearchResponse } from "./utils.ts";

/**
 * The network seam: one provider request. The orchestrator never imports a
 * provider adapter directly; the edge wires the real Exa/Tavily/Brave dispatch
 * in here.
 */
export type SearchNetworkPort = (
	target: SearchTarget,
	query: string,
	options: SearchOptions,
) => Promise<SearchResponse>;

/**
 * The accounting seam. Attempt history feeds least-used routing and recorded
 * events are the usage ledger. Both directions reuse `src/ledger.ts`; the port
 * exists so tests can drive the orchestrator without a filesystem.
 */
export interface LedgerPort {
	/** Attempt timestamps (ms) per credential alias, for least-used routing. */
	attemptsByAlias(now: number): Record<string, number[]>;
	/** Append the accounting events for one query. */
	record(events: LedgerEvent[], now: number): void;
}

/**
 * The cooldown/threshold seam. Penalties feed routing; failures feed the
 * cooldown store. Persistence lives in `src/health.ts` behind the same injected
 * store pattern as the ledger.
 */
export interface HealthPort {
	/** Active penalties (cooldowns, demotions) per alias, for the selector. */
	penalties(now: number): Record<string, PenaltyState>;
	/** Enter a time-bounded cooldown for any failure whose category triggers one. */
	record(failures: readonly CooldownFailure[], now: number): void;
}

/**
 * Every effect the orchestrator needs. Nothing here reads `process.env`,
 * `Date.now`, `fetch`, or the filesystem directly.
 */
export interface OrchestratorDeps {
	/** Injected clock (ms). */
	now(): number;
	/** Injected request-id generator for request-versus-attempt accounting. */
	newRequestId(): string;
	search: SearchNetworkPort;
	/** Credential resolution; the edge passes `process.env`. */
	resolveCredentials(config: SearchControlConfig): ResolvedCredential[];
	ledger: LedgerPort;
	health: HealthPort;
}

/** Ledger port that records nothing and reports no history. */
export const noopLedger: LedgerPort = {
	attemptsByAlias: () => ({}),
	record: () => {},
};

/** Health port that reports no cooldowns and records none. */
export const noHealth: HealthPort = {
	penalties: () => ({}),
	record: () => {},
};

/**
 * Wrap the health store as an orchestrator port, mirroring `createLedgerPort`.
 * Warnings are surfaced through `onWarning` so a damaged store degrades rather
 * than failing a search.
 */
export function createHealthPort(
	store: HealthStore,
	options: { onWarning?(warning: string | undefined): void } = {},
): HealthPort {
	return {
		penalties(now: number): Record<string, PenaltyState> {
			return penaltiesFromHealth(loadHealth(store, now).state, now);
		},
		record(failures: readonly CooldownFailure[], now: number): void {
			try {
				const { warning } = recordCooldowns(store, failures, now);
				options.onWarning?.(warning);
			} catch (err) {
				options.onWarning?.(
					`Health store write failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}

/**
 * Wrap the existing ledger store as an orchestrator port. Persistence stays in
 * `src/ledger.ts`; this only adapts its read/write shape. Warnings are surfaced
 * through `onWarning` so the ledger stays diagnostics and never fails a search.
 */
export function createLedgerPort(
	store: LedgerStore,
	options: { retentionMs?: number; onWarning?(warning: string | undefined): void } = {},
): LedgerPort {
	const retentionMs = options.retentionMs ?? DETAIL_RETENTION_MS;
	return {
		attemptsByAlias(now: number): Record<string, number[]> {
			const { state } = loadLedger(store, now, retentionMs);
			const byAlias: Record<string, number[]> = {};
			for (const event of state.events) {
				if (event.kind !== "attempt") continue;
				(byAlias[event.alias] ??= []).push(event.at);
			}
			return byAlias;
		},
		record(events: LedgerEvent[], now: number): void {
			try {
				const { warning } = recordLedgerEvents(store, events, now, retentionMs);
				options.onWarning?.(warning);
			} catch (err) {
				options.onWarning?.(
					`Usage ledger write failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}

export interface OrchestratorQuery {
	query: string;
	config: SearchControlConfig;
	profile: SearchProfile;
	sessionId: string;
	options?: Partial<SearchOptions>;
}

/** A routed query's outcome; failures carry their message, successes their markdown. */
export type SearchOutcome =
	| (RoutedSearchResult & { attempts: FailedAttempt[] })
	| { query: string; error: string };

export interface SearchBatchInput {
	queries: string[];
	config: SearchControlConfig;
	profile: SearchProfile;
	sessionId: string;
	options?: Partial<SearchOptions>;
	/** Optional progress callback; the Pi surface uses it to stream updates. */
	onQuery?(current: number, total: number, query: string): void;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Build the ledger events for one logical query: one Search Request, one
 * Provider Attempt per failed target, and one for the successful target when
 * there is one. Carries no query text.
 */
function buildAccountingEvents(
	config: SearchControlConfig,
	sessionId: string,
	requestId: string,
	profileName: string,
	at: number,
	failed: FailedAttempt[],
	success: { provider: SearchTarget["provider"]; alias: string } | undefined,
): LedgerEvent[] {
	const events: LedgerEvent[] = [{ kind: "request", at, sessionId, requestId, profile: profileName }];
	for (const attempt of failed) {
		const estimate = estimateAttempt(config.estimates[attempt.provider]);
		events.push({
			kind: "attempt",
			at,
			sessionId,
			requestId,
			provider: attempt.provider,
			alias: attempt.alias,
			outcome: "failure",
			errorCategory: attempt.errorCategory,
			units: estimate.units,
			costUsd: estimate.costUsd,
			estimatorVersion: estimate.version,
			estimatorDate: estimate.date,
		});
	}
	if (success) {
		const estimate = estimateAttempt(config.estimates[success.provider]);
		events.push({
			kind: "attempt",
			at,
			sessionId,
			requestId,
			provider: success.provider,
			alias: success.alias,
			outcome: "success",
			units: estimate.units,
			costUsd: estimate.costUsd,
			estimatorVersion: estimate.version,
			estimatorDate: estimate.date,
		});
	}
	return events;
}

function recordAccounting(deps: OrchestratorDeps, events: LedgerEvent[], at: number): void {
	// The usage ledger is diagnostics: a write failure must never fail a search.
	try {
		deps.ledger.record(events, at);
	} catch {
		// Swallowed on purpose; the edge port reports warnings.
	}
}

function recordCooldown(deps: OrchestratorDeps, failure: FailedAttempt, at: number): void {
	// Cooldown state is diagnostics: a write failure must never fail a search.
	try {
		deps.health.record([{ alias: failure.alias, errorCategory: failure.errorCategory }], at);
	} catch {
		// Swallowed on purpose; the edge port reports warnings.
	}
}

/**
 * Route one logical query through the Search Profile's ordered plan. Fallback
 * happens only on technical failure: the first technically successful response
 * is returned even when it is empty. Abort errors propagate immediately and are
 * never treated as a fallback trigger. On total failure the thrown
 * `SearchFailureError` carries the structured attempts (provider, alias, error,
 * errorCategory) and no key material.
 */
export async function orchestrateSearch(
	query: OrchestratorQuery,
	deps: OrchestratorDeps,
): Promise<RoutedSearchResult & { attempts: FailedAttempt[] }> {
	const { config, profile, sessionId, options = {} } = query;
	const at = deps.now();
	const credentials = deps.resolveCredentials(config);
	const plan = buildSearchPlan(profile, credentials, {
		now: at,
		attemptsByAlias: deps.ledger.attemptsByAlias(at),
		penalties: deps.health.penalties(at),
	});
	const requestId = deps.newRequestId();
	if (plan.length === 0) {
		// The query was still submitted to the control plane, so it is a Search
		// Request with zero Provider Attempts (requirements.md: Usage ledger).
		recordAccounting(
			deps,
			buildAccountingEvents(config, sessionId, requestId, profile.name, at, [], undefined),
			at,
		);
		throw new Error(noUsableCredentialsMessage(profile, credentials));
	}
	const searchOptions: SearchOptions = {
		numResults: options.numResults ?? config.search.numResults,
		timeoutMs: options.timeoutMs ?? config.search.timeoutMs,
		signal: options.signal,
	};

	const attempts: FailedAttempt[] = [];
	for (const target of plan) {
		try {
			const response = await deps.search(target, query.query, searchOptions);
			recordAccounting(
				deps,
				buildAccountingEvents(config, sessionId, requestId, profile.name, at, attempts, {
					provider: target.provider,
					alias: target.alias,
				}),
				at,
			);
			return {
				query: query.query,
				provider: target.provider,
				alias: target.alias,
				answer: response.answer,
				results: response.results,
				markdown: formatSearchMarkdown(query.query, target.provider, target.alias, response),
				attempts,
			};
		} catch (err) {
			if (isAbortError(err)) throw err;
			const failure: FailedAttempt = {
				provider: target.provider,
				alias: target.alias,
				error: errorMessage(err),
				errorCategory: classifyError(err),
			};
			attempts.push(failure);
			recordCooldown(deps, failure, at);
		}
	}

	recordAccounting(
		deps,
		buildAccountingEvents(config, sessionId, requestId, profile.name, at, attempts, undefined),
		at,
	);
	throw new SearchFailureError(attempts);
}

/**
 * Route each query independently: one query's failure or provider choice never
 * changes another's. A query with no technically successful target becomes an
 * error entry while the rest of the batch keeps its usable output. Abort
 * propagates and stops the batch.
 */
export async function orchestrateBatch(
	input: SearchBatchInput,
	deps: OrchestratorDeps,
): Promise<SearchOutcome[]> {
	const outcomes: SearchOutcome[] = [];
	for (let i = 0; i < input.queries.length; i++) {
		const query = input.queries[i];
		input.onQuery?.(i + 1, input.queries.length, query);
		try {
			outcomes.push(
				await orchestrateSearch(
					{
						query,
						config: input.config,
						profile: input.profile,
						sessionId: input.sessionId,
						options: input.options,
					},
					deps,
				),
			);
		} catch (err) {
			if (isAbortError(err)) throw err;
			if (err instanceof SearchFailureError) {
				outcomes.push({ query, error: err.message });
				continue;
			}
			throw err;
		}
	}
	return outcomes;
}