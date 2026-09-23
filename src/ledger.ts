import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PROVIDERS, type Provider } from "./config.ts";
import { ProviderFailureError } from "./provider-failure.ts";

/** Per-attempt detail older than this is folded into aggregates and dropped. */
export const DETAIL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const LEDGER_VERSION = 1;

export const DEFAULT_LEDGER_PATH = join(homedir(), ".pi", "search-control", "ledger.json");

export type ErrorCategory = "auth" | "rate_limit" | "quota" | "timeout" | "service" | "network" | "unknown";
export type AttemptOutcome = "success" | "failure";
export type Granularity = "daily" | "monthly";

/** One logical query the control plane was asked to satisfy. Carries no query text. */
export interface SearchRequestEvent {
	kind: "request";
	at: number;
	sessionId: string;
	requestId: string;
	profile: string;
}

/** One external request made with a specific provider credential. Carries no query text. */
export interface ProviderAttemptEvent {
	kind: "attempt";
	at: number;
	sessionId: string;
	requestId: string;
	provider: Provider;
	alias: string;
	outcome: AttemptOutcome;
	errorCategory?: ErrorCategory;
	units: number;
	costUsd: number;
	estimatorVersion: string;
	estimatorDate: string;
}

export type LedgerEvent = SearchRequestEvent | ProviderAttemptEvent;

export interface GroupCounts {
	attempts: number;
	success: number;
	failure: number;
	units: number;
	costUsd: number;
}

export interface LedgerSummary {
	requests: number;
	attempts: number;
	success: number;
	failure: number;
	units: number;
	costUsd: number;
	byProvider: Record<string, GroupCounts>;
	byAlias: Record<string, GroupCounts>;
}

export interface LedgerBucket {
	granularity: Granularity;
	period: string;
	requests: number;
	attempts: number;
	success: number;
	failure: number;
	units: number;
	costUsd: number;
	byProvider: Record<string, GroupCounts>;
	byAlias: Record<string, GroupCounts>;
}

export interface LedgerState {
	version: number;
	events: LedgerEvent[];
	buckets: LedgerBucket[];
}

export interface LedgerReadResult {
	state: LedgerState;
	warning?: string;
}

/** Persistence seam. Both the ledger and, later, the health store read and write through this. */
export interface LedgerStore {
	read(): LedgerReadResult;
	write(state: LedgerState): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
	return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`ledger field "${name}" must be a non-empty string`);
	}
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`ledger field "${name}" must be a finite number`);
	}
	return value;
}

const ERROR_CATEGORIES: readonly ErrorCategory[] = ["auth", "rate_limit", "quota", "timeout", "service", "network", "unknown"];

/**
 * Classify a provider failure into a coarse category for the ledger. Deliberately
 * shallow: it only labels what the error text makes obvious and never inspects a
 * credential. Pure.
 */
export function classifyError(error: unknown): ErrorCategory {
	// A structured provider failure already knows its category; never re-derive
	// it from text, which could disagree or be attacker-controlled.
	if (error instanceof ProviderFailureError) return error.category;
	const name = error instanceof Error ? error.name : "";
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	if (name === "TimeoutError" || message.includes("timeout") || message.includes("timed out")) return "timeout";
	if (message.includes("402") || message.includes("quota") || message.includes("payment required")) return "quota";
	if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
		return "rate_limit";
	}
	if (
		message.includes("401") ||
		message.includes("403") ||
		message.includes("unauthor") ||
		message.includes("forbidden") ||
		message.includes("invalid api key")
	) {
		return "auth";
	}
	if (/\b5\d\d\b/.test(message) || message.includes("service unavailable") || message.includes("bad gateway")) {
		return "service";
	}
	if (
		message.includes("fetch failed") ||
		message.includes("network") ||
		message.includes("econnrefused") ||
		message.includes("enotfound")
	) {
		return "network";
	}
	return "unknown";
}

function parseEvent(raw: unknown): LedgerEvent {
	if (!isRecord(raw)) throw new Error("ledger event must be an object");
	if (raw.kind === "request") {
		return {
			kind: "request",
			at: requireNumber(raw.at, "at"),
			sessionId: requireString(raw.sessionId, "sessionId"),
			requestId: requireString(raw.requestId, "requestId"),
			profile: requireString(raw.profile, "profile"),
		};
	}
	if (raw.kind === "attempt") {
		if (!isProvider(raw.provider)) throw new Error(`ledger attempt has unknown provider ${JSON.stringify(raw.provider)}`);
		if (raw.outcome !== "success" && raw.outcome !== "failure") {
			throw new Error(`ledger attempt has invalid outcome ${JSON.stringify(raw.outcome)}`);
		}
		let errorCategory: ErrorCategory | undefined;
		if (raw.errorCategory !== undefined) {
			if (!ERROR_CATEGORIES.includes(raw.errorCategory as ErrorCategory)) {
				throw new Error(`ledger attempt has invalid errorCategory ${JSON.stringify(raw.errorCategory)}`);
			}
			errorCategory = raw.errorCategory as ErrorCategory;
		}
		const attempt: ProviderAttemptEvent = {
			kind: "attempt",
			at: requireNumber(raw.at, "at"),
			sessionId: requireString(raw.sessionId, "sessionId"),
			requestId: requireString(raw.requestId, "requestId"),
			provider: raw.provider,
			alias: requireString(raw.alias, "alias"),
			outcome: raw.outcome,
			units: requireNumber(raw.units, "units"),
			costUsd: requireNumber(raw.costUsd, "costUsd"),
			estimatorVersion: requireString(raw.estimatorVersion, "estimatorVersion"),
			estimatorDate: requireString(raw.estimatorDate, "estimatorDate"),
		};
		if (errorCategory !== undefined) attempt.errorCategory = errorCategory;
		return attempt;
	}
	throw new Error(`ledger event has unknown kind ${JSON.stringify(raw.kind)}`);
}

function emptyCounts(): GroupCounts {
	return { attempts: 0, success: 0, failure: 0, units: 0, costUsd: 0 };
}

function parseCounts(raw: unknown): Record<string, GroupCounts> {
	if (!isRecord(raw)) return {};
	const counts: Record<string, GroupCounts> = {};
	for (const key of Object.keys(raw)) {
		const value = raw[key];
		if (!isRecord(value)) continue;
		counts[key] = {
			attempts: requireNumber(value.attempts, "attempts"),
			success: requireNumber(value.success, "success"),
			failure: requireNumber(value.failure, "failure"),
			units: requireNumber(value.units, "units"),
			costUsd: requireNumber(value.costUsd, "costUsd"),
		};
	}
	return counts;
}

function parseBucket(raw: unknown): LedgerBucket {
	if (!isRecord(raw)) throw new Error("ledger bucket must be an object");
	if (raw.granularity !== "daily" && raw.granularity !== "monthly") {
		throw new Error(`ledger bucket has invalid granularity ${JSON.stringify(raw.granularity)}`);
	}
	return {
		granularity: raw.granularity,
		period: requireString(raw.period, "period"),
		requests: requireNumber(raw.requests, "requests"),
		attempts: requireNumber(raw.attempts, "attempts"),
		success: requireNumber(raw.success, "success"),
		failure: requireNumber(raw.failure, "failure"),
		units: requireNumber(raw.units, "units"),
		costUsd: requireNumber(raw.costUsd, "costUsd"),
		byProvider: parseCounts(raw.byProvider),
		byAlias: parseCounts(raw.byAlias),
	};
}

/** Validate a persisted ledger document. Throws on anything that is not a ledger. */
export function parseLedgerState(raw: unknown): LedgerState {
	if (!isRecord(raw)) throw new Error("ledger must be a JSON object");
	if (raw.version !== LEDGER_VERSION) {
		throw new Error(`unsupported ledger version ${JSON.stringify(raw.version)}`);
	}
	if (!Array.isArray(raw.events)) throw new Error("ledger events must be an array");
	const buckets = raw.buckets === undefined ? [] : raw.buckets;
	if (!Array.isArray(buckets)) throw new Error("ledger buckets must be an array");
	return {
		version: LEDGER_VERSION,
		events: raw.events.map(parseEvent),
		buckets: buckets.map(parseBucket),
	};
}

export function emptyLedger(): LedgerState {
	return { version: LEDGER_VERSION, events: [], buckets: [] };
}

/** Period key in UTC so aggregates do not shift with the host timezone. */
export function periodKey(at: number, granularity: Granularity): string {
	const date = new Date(at);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	if (granularity === "monthly") return `${year}-${month}`;
	return `${year}-${month}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function accumulate(into: Record<string, GroupCounts>, key: string, event: ProviderAttemptEvent): void {
	const counts = into[key] ?? emptyCounts();
	counts.attempts++;
	if (event.outcome === "success") counts.success++;
	else counts.failure++;
	counts.units += event.units;
	counts.costUsd += event.costUsd;
	into[key] = counts;
}

/**
 * Fold a set of events into a summary. Requests and Provider Attempts are counted
 * separately; attempt totals are also grouped by provider and by credential alias.
 * Pure.
 */
export function summarizeEvents(
	events: LedgerEvent[],
	filter: { sessionId?: string } = {},
): LedgerSummary {
	const summary: LedgerSummary = {
		requests: 0,
		attempts: 0,
		success: 0,
		failure: 0,
		units: 0,
		costUsd: 0,
		byProvider: {},
		byAlias: {},
	};
	for (const event of events) {
		if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) continue;
		if (event.kind === "request") {
			summary.requests++;
			continue;
		}
		summary.attempts++;
		if (event.outcome === "success") summary.success++;
		else summary.failure++;
		summary.units += event.units;
		summary.costUsd += event.costUsd;
		accumulate(summary.byProvider, event.provider, event);
		accumulate(summary.byAlias, event.alias, event);
	}
	return summary;
}

/** Summarize the events that fall in the period containing `now`. Pure. */
export function summarizePeriod(
	events: LedgerEvent[],
	now: number,
	granularity: Granularity,
): LedgerSummary {
	const key = periodKey(now, granularity);
	return summarizeEvents(events.filter((event) => periodKey(event.at, granularity) === key));
}

function emptyBucket(granularity: Granularity, period: string): LedgerBucket {
	return {
		granularity,
		period,
		requests: 0,
		attempts: 0,
		success: 0,
		failure: 0,
		units: 0,
		costUsd: 0,
		byProvider: {},
		byAlias: {},
	};
}

function addEventToBucket(bucket: LedgerBucket, event: LedgerEvent): void {
	if (event.kind === "request") {
		bucket.requests++;
		return;
	}
	bucket.attempts++;
	if (event.outcome === "success") bucket.success++;
	else bucket.failure++;
	bucket.units += event.units;
	bucket.costUsd += event.costUsd;
	accumulate(bucket.byProvider, event.provider, event);
	accumulate(bucket.byAlias, event.alias, event);
}

function bucketKey(bucket: LedgerBucket): string {
	return `${bucket.granularity}:${bucket.period}`;
}

/** Fold events into daily and monthly buckets. Pure. */
export function bucketEvents(events: LedgerEvent[]): LedgerBucket[] {
	const buckets = new Map<string, LedgerBucket>();
	for (const event of events) {
		for (const granularity of ["daily", "monthly"] as const) {
			const period = periodKey(event.at, granularity);
			const key = `${granularity}:${period}`;
			const bucket = buckets.get(key) ?? emptyBucket(granularity, period);
			addEventToBucket(bucket, event);
			buckets.set(key, bucket);
		}
	}
	return [...buckets.values()];
}

function cloneBucket(bucket: LedgerBucket): LedgerBucket {
	return {
		...bucket,
		byProvider: Object.fromEntries(Object.entries(bucket.byProvider).map(([key, value]) => [key, { ...value }])),
		byAlias: Object.fromEntries(Object.entries(bucket.byAlias).map(([key, value]) => [key, { ...value }])),
	};
}

function mergeCounts(into: Record<string, GroupCounts>, from: Record<string, GroupCounts>): void {
	for (const [key, value] of Object.entries(from)) {
		const counts = into[key] ?? emptyCounts();
		counts.attempts += value.attempts;
		counts.success += value.success;
		counts.failure += value.failure;
		counts.units += value.units;
		counts.costUsd += value.costUsd;
		into[key] = counts;
	}
}

function mergeBucket(into: LedgerBucket, from: LedgerBucket): void {
	into.requests += from.requests;
	into.attempts += from.attempts;
	into.success += from.success;
	into.failure += from.failure;
	into.units += from.units;
	into.costUsd += from.costUsd;
	mergeCounts(into.byProvider, from.byProvider);
	mergeCounts(into.byAlias, from.byAlias);
}

/** Merge fresh buckets into existing long-term aggregates. Pure. */
export function mergeBuckets(existing: LedgerBucket[], additions: LedgerBucket[]): LedgerBucket[] {
	const buckets = new Map<string, LedgerBucket>();
	for (const bucket of existing) buckets.set(bucketKey(bucket), cloneBucket(bucket));
	for (const bucket of additions) {
		const key = bucketKey(bucket);
		const found = buckets.get(key);
		if (found) mergeBucket(found, bucket);
		else buckets.set(key, cloneBucket(bucket));
	}
	return [...buckets.values()];
}

/**
 * Prune per-attempt detail older than the retention window into long-term daily
 * and monthly aggregates. An event exactly `retentionMs` old is still kept; only
 * strictly older events are pruned. Pure: the clock is the injected `now`.
 */
export function pruneLedger(
	state: LedgerState,
	now: number,
	retentionMs: number = DETAIL_RETENTION_MS,
): LedgerState {
	const cutoff = now - retentionMs;
	const expired = state.events.filter((event) => event.at < cutoff);
	if (expired.length === 0) return state;
	const kept = state.events.filter((event) => event.at >= cutoff);
	return {
		version: LEDGER_VERSION,
		events: kept,
		buckets: mergeBuckets(state.buckets, bucketEvents(expired)),
	};
}

/** Read the ledger and prune it for display. Never throws: damage degrades to an empty ledger. */
export function loadLedger(
	store: LedgerStore,
	now: number,
	retentionMs: number = DETAIL_RETENTION_MS,
): LedgerReadResult {
	const read = store.read();
	return { state: pruneLedger(read.state, now, retentionMs), warning: read.warning };
}

/** Append events to the ledger after pruning, through the injected store. */
export function recordLedgerEvents(
	store: LedgerStore,
	events: LedgerEvent[],
	now: number,
	retentionMs: number = DETAIL_RETENTION_MS,
): LedgerReadResult {
	const read = store.read();
	const pruned = pruneLedger(read.state, now, retentionMs);
	const next: LedgerState = { ...pruned, events: [...pruned.events, ...events] };
	store.write(next);
	return { state: next, warning: read.warning };
}

function damageWarning(path: string, err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `Usage ledger at ${path} is unreadable and was ignored: ${message}`;
}

export function createFileLedgerStore(path: string = DEFAULT_LEDGER_PATH): LedgerStore {
	return {
		read(): LedgerReadResult {
			if (!existsSync(path)) return { state: emptyLedger() };
			try {
				return { state: parseLedgerState(JSON.parse(readFileSync(path, "utf8"))) };
			} catch (err) {
				return { state: emptyLedger(), warning: damageWarning(path, err) };
			}
		},
		write(state: LedgerState): void {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			renameSync(tmp, path);
		},
	};
}

export function createMemoryLedgerStore(initial: LedgerState = emptyLedger()): LedgerStore {
	let state = initial;
	return {
		read(): LedgerReadResult {
			return { state };
		},
		write(next: LedgerState): void {
			state = next;
		},
	};
}