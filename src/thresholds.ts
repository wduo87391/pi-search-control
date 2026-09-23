import type { Provider, UsagePeriod } from "./config.ts";
import type { ResolvedCredential } from "./credentials.ts";
import { attemptsInPeriod, usagePeriodKey, type PenaltyState } from "./selection.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A credential that has reached its configured local warning threshold within
 * its active usage period. Carries the alias only, never key material or the
 * environment-variable name.
 */
export interface ThresholdCrossing {
	alias: string;
	provider: Provider;
	threshold: number;
	attempts: number;
	/**
	 * Identity of the credential's active period at the crossing instant. Used to
	 * deduplicate warnings: the same credential crossing again in a later period
	 * is a new crossing.
	 */
	periodKey: string;
}

/**
 * The period identity used for warning dedup. Calendar periods reuse the
 * ledger's period key. Rolling windows have no discrete calendar key, so the
 * trailing window's start is bucketed by UTC day: a warning is not repeated
 * within a day, and can reappear as the window advances.
 */
function thresholdPeriodKey(period: UsagePeriod, at: number): string {
	const key = usagePeriodKey(period, at);
	if (key !== undefined) return key;
	const days = period.days ?? 0;
	const windowStart = at - days * DAY_MS;
	return `rolling-days:${days}:${Math.floor(windowStart / DAY_MS)}`;
}

/**
 * The credentials that have reached their configured threshold in the active
 * period containing `now`. Pure: attempt times and the clock are injected, and
 * credentials without a threshold are never included. Unavailable credentials
 * are skipped too: warning about a credential that cannot be used is noise.
 */
export function thresholdCrossings(
	credentials: readonly ResolvedCredential[],
	attemptsByAlias: Record<string, number[]>,
	now: number,
): ThresholdCrossing[] {
	const crossings: ThresholdCrossing[] = [];
	for (const credential of credentials) {
		if (!credential.available) continue;
		if (credential.threshold === undefined) continue;
		const attempts = attemptsInPeriod(attemptsByAlias[credential.alias] ?? [], credential.period, now);
		if (attempts < credential.threshold) continue;
		crossings.push({
			alias: credential.alias,
			provider: credential.provider,
			threshold: credential.threshold,
			attempts,
			periodKey: thresholdPeriodKey(credential.period, now),
		});
	}
	return crossings;
}

/**
 * Demotion penalties for every credential that has crossed its configured
 * threshold. Pure. A crossed credential is `demoted` (ranked last among
 * eligible candidates), never excluded.
 */
export function thresholdPenalties(
	credentials: readonly ResolvedCredential[],
	attemptsByAlias: Record<string, number[]>,
	now: number,
): Record<string, PenaltyState> {
	const penalties: Record<string, PenaltyState> = {};
	for (const crossing of thresholdCrossings(credentials, attemptsByAlias, now)) {
		penalties[crossing.alias] = "demoted";
	}
	return penalties;
}

/**
 * Merge health penalties with threshold demotions. Health (cooldown) wins: a
 * cooling credential stays excluded even when it is also threshold-crossed.
 */
export function mergePenalties(
	health: Record<string, PenaltyState>,
	threshold: Record<string, PenaltyState>,
): Record<string, PenaltyState> {
	return { ...threshold, ...health };
}

/** A user-facing warning for one crossing. Identifies the credential by alias only. */
export function formatThresholdWarning(crossing: ThresholdCrossing): string {
	return (
		`Credential "${crossing.alias}" reached its local warning threshold: ` +
		`${crossing.attempts} Provider Attempts this period (threshold ${crossing.threshold}). ` +
		"It is demoted in routing but remains usable."
	);
}

export interface ThresholdWarner {
	/**
	 * Warning messages for crossings not yet reported in their period. A repeat
	 * search within the same period returns nothing; a later period returns the
	 * warning again. State is in-memory and keyed by alias plus period identity.
	 */
	warningsFor(crossings: readonly ThresholdCrossing[]): string[];
}

/** Create a stateful, per-period warning deduplicator. */
export function createThresholdWarner(): ThresholdWarner {
	const warned = new Set<string>();
	return {
		warningsFor(crossings: readonly ThresholdCrossing[]): string[] {
			const messages: string[] = [];
			for (const crossing of crossings) {
				const key = `${crossing.alias}:${crossing.periodKey}`;
				if (warned.has(key)) continue;
				warned.add(key);
				messages.push(formatThresholdWarning(crossing));
			}
			return messages;
		},
	};
}
