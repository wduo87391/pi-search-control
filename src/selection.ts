import type { UsagePeriod } from "./config.ts";
import { periodKey, type Granularity } from "./ledger.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The active usage period assumed when a credential declaration omits one. Free
 * provider tiers typically reset monthly, so calendar-month is the safe default.
 */
export const DEFAULT_USAGE_PERIOD: UsagePeriod = { kind: "calendar-month" };

/** Routing penalties supplied by later health/threshold tickets (07/08). */
export type PenaltyState = "demoted" | "cooling";

/**
 * One credential offered to the selector, already resolved against the
 * environment so `available` is known. Candidates are expected to belong to a
 * single provider: ranking happens within a provider, and the tie-break uses the
 * provider's own attempt total.
 */
export interface CredentialCandidate {
	alias: string;
	available: boolean;
	/** Active usage period; pass DEFAULT_USAGE_PERIOD when the declaration omits one. */
	period: UsagePeriod;
	/** Timestamps (ms) of this credential's recorded attempts. */
	attemptTimes: number[];
}

export interface RankOptions {
	/** Injected clock: ranking is pure and never reads the system time. */
	now: number;
	/** Optional alias -> penalty lookup; absent means no penalties. */
	penalties?: Record<string, PenaltyState>;
}

function granularityFor(period: UsagePeriod): Granularity | undefined {
	if (period.kind === "calendar-day") return "daily";
	if (period.kind === "calendar-month") return "monthly";
	return undefined;
}

/**
 * The period key for a calendar period at `at`, reusing the ledger's UTC
 * `periodKey` so the selector and the ledger can never disagree about which
 * attempts belong to a period. Rolling windows have no single key and return
 * `undefined`.
 */
export function usagePeriodKey(period: UsagePeriod, at: number): string | undefined {
	const granularity = granularityFor(period);
	return granularity === undefined ? undefined : periodKey(at, granularity);
}

/**
 * Count attempts that fall in the credential's active period containing `now`.
 * Pure. Calendar windows match the ledger's UTC `periodKey`; rolling windows are
 * trailing, inclusive of both endpoints, and ignore attempts newer than `now`.
 */
export function attemptsInPeriod(attemptTimes: number[], period: UsagePeriod, now: number): number {
	if (period.kind === "rolling-days") {
		const windowStart = now - (period.days ?? 0) * DAY_MS;
		return attemptTimes.filter((at) => at >= windowStart && at <= now).length;
	}
	const key = usagePeriodKey(period, now);
	return attemptTimes.filter((at) => usagePeriodKey(period, at) === key).length;
}

/**
 * Order one provider's credentials by least-used-first for the current usage
 * period. Pure: the clock and penalties are injected, and identical inputs always
 * produce identical output.
 *
 * Rules:
 * - unavailable credentials and `cooling` credentials are excluded;
 * - `demoted` credentials stay eligible but sort after every non-demoted one;
 * - otherwise the credential with the fewest attempts in its active period leads.
 *
 * Tie-break: a pure function cannot keep a counter, so the rotation is derived
 * from the data. The provider's total attempts across the eligible candidates is
 * taken modulo the number of candidates sharing a tie, and that many positions
 * rotates the declaration order of the tied group. This is deterministic and
 * advances as attempts accumulate, giving round-robin behaviour without state.
 */
export function rankCredentials(candidates: CredentialCandidate[], options: RankOptions): CredentialCandidate[] {
	const { now, penalties = {} } = options;
	const eligible = candidates.filter(
		(candidate) => candidate.available && penalties[candidate.alias] !== "cooling"
	);

	const counts = new Map<string, number>();
	let providerAttempts = 0;
	for (const candidate of eligible) {
		const count = attemptsInPeriod(candidate.attemptTimes, candidate.period, now);
		counts.set(candidate.alias, count);
		providerAttempts += count;
	}

	// Group tied candidates while preserving declaration order, then order the
	// groups by (demoted, attempt count).
	const groups = new Map<string, CredentialCandidate[]>();
	const groupKeys: string[] = [];
	for (const candidate of eligible) {
		const demoted = penalties[candidate.alias] === "demoted" ? 1 : 0;
		const key = `${demoted}:${counts.get(candidate.alias)}`;
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, [candidate]);
			groupKeys.push(key);
		} else {
			group.push(candidate);
		}
	}

	groupKeys.sort((a, b) => {
		const [aDemoted, aCount] = a.split(":").map(Number);
		const [bDemoted, bCount] = b.split(":").map(Number);
		return aDemoted - bDemoted || aCount - bCount;
	});

	const ranked: CredentialCandidate[] = [];
	for (const key of groupKeys) {
		const group = groups.get(key)!;
		const rotation = providerAttempts % group.length;
		for (let i = 0; i < group.length; i++) {
			ranked.push(group[(i + rotation) % group.length]);
		}
	}
	return ranked;
}