import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ErrorCategory } from "./ledger.ts";
import type { PenaltyState } from "./selection.ts";

export const HEALTH_VERSION = 1;

export const DEFAULT_HEALTH_PATH = join(homedir(), ".pi", "search-control", "health.json");

/**
 * Cooldown applied after a rate-limit failure. Rate limits are provider-imposed
 * and usually reset on a known cadence, so they get the longer window.
 */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Cooldown applied after quota exhaustion (HTTP 402). A quota window is not
 * necessarily short, but a five-minute pause is long enough to stop hammering
 * an exhausted credential while still letting it recover within a session.
 */
export const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Cooldown applied after a transient failure (timeout, service, network). Kept
 * short so a momentary blip cannot sideline an otherwise healthy credential.
 */
export const TRANSIENT_COOLDOWN_MS = 60 * 1000;

/**
 * Which error categories trigger a cooldown and for how long. Deliberately
 * omits `auth` (a permanent configuration problem, not a transient one) and
 * `unknown` (unclassified, so we do not guess that it is transient). Exact
 * intervals are an implementation design decision (requirements.md).
 */
export const COOLDOWN_DURATIONS: Partial<Record<ErrorCategory, number>> = {
	rate_limit: RATE_LIMIT_COOLDOWN_MS,
	quota: QUOTA_COOLDOWN_MS,
	timeout: TRANSIENT_COOLDOWN_MS,
	service: TRANSIENT_COOLDOWN_MS,
	network: TRANSIENT_COOLDOWN_MS,
};

/** The cooldown window for a category, or `undefined` when the category does not cool. */
export function cooldownDurationFor(category: ErrorCategory): number | undefined {
	return COOLDOWN_DURATIONS[category];
}

/** One credential's active cooldown. Carries no key material, only the alias. */
export interface CooldownEntry {
	category: ErrorCategory;
	enteredAt: number;
	until: number;
}

export interface HealthState {
	version: number;
	/** Alias -> active cooldown. Expired entries are pruned on every read/write. */
	cooldowns: Record<string, CooldownEntry>;
}

export interface HealthReadResult {
	state: HealthState;
	warning?: string;
}

/** Persistence seam, shared with the ledger's injection point. */
export interface HealthStore {
	read(): HealthReadResult;
	write(state: HealthState): void;
}

/** A failed attempt's alias and category; the only fields the health store needs. */
export interface CooldownFailure {
	alias: string;
	errorCategory: ErrorCategory;
}

const ERROR_CATEGORIES: readonly ErrorCategory[] = ["auth", "rate_limit", "quota", "timeout", "service", "network", "unknown"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`health field "${name}" must be a non-empty string`);
	}
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`health field "${name}" must be a finite number`);
	}
	return value;
}

export function emptyHealth(): HealthState {
	return { version: HEALTH_VERSION, cooldowns: {} };
}

/** Validate a persisted health document. Throws on anything that is not a health store. */
export function parseHealthState(raw: unknown): HealthState {
	if (!isRecord(raw)) throw new Error("health store must be a JSON object");
	if (raw.version !== HEALTH_VERSION) {
		throw new Error(`unsupported health store version ${JSON.stringify(raw.version)}`);
	}
	const rawCooldowns = raw.cooldowns === undefined ? {} : raw.cooldowns;
	if (!isRecord(rawCooldowns)) throw new Error("health store cooldowns must be an object");
	const cooldowns: Record<string, CooldownEntry> = {};
	for (const alias of Object.keys(rawCooldowns)) {
		const entry = rawCooldowns[alias];
		if (!isRecord(entry)) throw new Error(`health cooldown "${alias}" must be an object`);
		const category = entry.category;
		if (!ERROR_CATEGORIES.includes(category as ErrorCategory)) {
			throw new Error(`health cooldown "${alias}" has invalid category ${JSON.stringify(category)}`);
		}
		cooldowns[requireString(alias, "alias")] = {
			category: category as ErrorCategory,
			enteredAt: requireNumber(entry.enteredAt, "enteredAt"),
			until: requireNumber(entry.until, "until"),
		};
	}
	return { version: HEALTH_VERSION, cooldowns };
}

/**
 * Drop cooldowns whose expiry has passed. An entry exactly at `now` is expired;
 * only `until > now` is still cooling. Pure: the clock is injected.
 */
export function pruneHealth(state: HealthState, now: number): HealthState {
	const cooldowns: Record<string, CooldownEntry> = {};
	for (const [alias, entry] of Object.entries(state.cooldowns)) {
		if (entry.until > now) cooldowns[alias] = { ...entry };
	}
	return { version: HEALTH_VERSION, cooldowns };
}

/** The cooldowns still in effect at `now`. Pure. */
export function activeCooldowns(state: HealthState, now: number): Record<string, CooldownEntry> {
	return pruneHealth(state, now).cooldowns;
}

/**
 * Enter or extend a cooldown for every failure whose category triggers one.
 * A still-active longer cooldown is kept; otherwise the fresh window replaces
 * the old one. Pure. Returns a new state; the input is not mutated.
 */
export function enterCooldowns(
	state: HealthState,
	failures: readonly CooldownFailure[],
	now: number,
): HealthState {
	const next = pruneHealth(state, now);
	for (const failure of failures) {
		const duration = cooldownDurationFor(failure.errorCategory);
		if (duration === undefined) continue;
		const until = now + duration;
		const existing = next.cooldowns[failure.alias];
		if (existing && existing.until >= until) continue;
		next.cooldowns[failure.alias] = {
			category: failure.errorCategory,
			enteredAt: now,
			until,
		};
	}
	return next;
}

/** Penalties for the shared selector: every active cooldown is `cooling`. Pure. */
export function penaltiesFromHealth(state: HealthState, now: number): Record<string, PenaltyState> {
	const penalties: Record<string, PenaltyState> = {};
	for (const alias of Object.keys(activeCooldowns(state, now))) penalties[alias] = "cooling";
	return penalties;
}

/** Read the health store and prune it for display. Damage degrades to an empty store. */
export function loadHealth(store: HealthStore, now: number): HealthReadResult {
	const read = store.read();
	return { state: pruneHealth(read.state, now), warning: read.warning };
}

/** Record cooldowns through the injected store, pruning first. */
export function recordCooldowns(
	store: HealthStore,
	failures: readonly CooldownFailure[],
	now: number,
): HealthReadResult {
	const read = store.read();
	const next = enterCooldowns(read.state, failures, now);
	store.write(next);
	return { state: next, warning: read.warning };
}

function damageWarning(path: string, err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `Health store at ${path} is unreadable and was ignored: ${message}`;
}

export function createFileHealthStore(path: string = DEFAULT_HEALTH_PATH): HealthStore {
	return {
		read(): HealthReadResult {
			if (!existsSync(path)) return { state: emptyHealth() };
			try {
				return { state: parseHealthState(JSON.parse(readFileSync(path, "utf8"))) };
			} catch (err) {
				return { state: emptyHealth(), warning: damageWarning(path, err) };
			}
		},
		write(state: HealthState): void {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
			renameSync(tmp, path);
		},
	};
}

export function createMemoryHealthStore(initial: HealthState = emptyHealth()): HealthStore {
	let state = initial;
	return {
		read(): HealthReadResult {
			return { state };
		},
		write(next: HealthState): void {
			state = next;
		},
	};
}