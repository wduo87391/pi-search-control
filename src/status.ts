import { PROVIDERS, type Provider, type SearchControlConfig, type UsagePeriod } from "./config.ts";
import type { ResolvedCredential } from "./credentials.ts";
import { estimateAttempt, formatEstimate, resolveEstimators, type Estimate } from "./estimates.ts";
import { activeCooldowns, penaltiesFromHealth, type CooldownEntry, type HealthState } from "./health.ts";
import {
	DETAIL_RETENTION_MS,
	summarizeEvents,
	summarizePeriodComplete,
	unitsInCalendarPeriod,
	type ErrorCategory,
	type GroupCounts,
	type LedgerState,
	type LedgerSummary,
} from "./ledger.ts";
import { buildSearchPlan } from "./search.ts";
import { attemptsInPeriod } from "./selection.ts";
import { mergePenalties, thresholdCrossings, thresholdPenalties } from "./thresholds.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One credential's Credential Allowance Estimate as shown in status. Purely
 * display: `estimatedUsed` is the locally recorded estimated units in the
 * allowance's explicit period, and `estimatedRemaining` is unknown whenever the
 * retained accounting cannot cover the whole period. `threshold` never enters
 * this calculation.
 */
export interface CredentialAllowanceStatus {
	units: number;
	period: UsagePeriod;
	source: "credential" | "provider-default";
	/** Locally recorded estimated units in the allowance period. */
	estimatedUsed: number;
	/** Estimated remaining units, or absent when coverage is incomplete. */
	estimatedRemaining?: number;
	/** `complete` when retained accounting covers the whole allowance period. */
	coverage: "complete" | "unknown";
}

/** One credential's diagnostic state. Carries the alias only, never key material. */
export interface CredentialStatus {
	alias: string;
	provider: Provider;
	/** Environment availability: the referenced variable resolved to a value. */
	available: boolean;
	/** Whether the credential's provider is named by the active Search Profile. */
	inProfile: boolean;
	/** Eligible for routing after availability and cooldown (demotion does not exclude). */
	eligible: boolean;
	/** Active Credential Cooldown, when one is in effect at the snapshot instant. */
	cooldown?: { category: ErrorCategory; enteredAt: number; until: number };
	/** Configured local warning threshold, when the credential declares one. */
	threshold?: number;
	/** Attempts in the credential's active usage period, for threshold display. */
	periodAttempts?: number;
	/** Whether the credential has crossed its configured threshold and is demoted. */
	demoted: boolean;
	/** Credential Allowance Estimate, when one applies. */
	allowance?: CredentialAllowanceStatus;
}

/** One provider's diagnostic record, present even when outside the active profile. */
export interface ProviderStatus {
	provider: Provider;
	inProfile: boolean;
	/** True for a configuration-error snapshot: no credential state is invented. */
	configurationUnavailable: boolean;
	/** At least one eligible credential exists within the active profile. */
	routeUsable: boolean;
	credentials: CredentialStatus[];
	/** The provider's per-attempt estimate rule, for reference. */
	estimate: Estimate;
	session: GroupCounts;
	day: GroupCounts;
	month: GroupCounts;
}

/** The Overview page's data: profile, route readiness, totals, and global warnings. */
export interface StatusOverview {
	profileName?: string;
	providerOrder: Provider[];
	/** True when the active profile has at least one eligible credential. */
	usableRoute: boolean;
	/** True only while an observed `quota` cooldown is active; never provider-authoritative. */
	quotaCondition: boolean;
	session: LedgerSummary;
	/** True when the session began before the 30-day detail-retention horizon. */
	sessionPartial: boolean;
	day: LedgerSummary;
	month: LedgerSummary;
	warnings: string[];
}

/**
 * A single immutable status snapshot. It is the one input to both the text
 * formatter and the TUI panel, so the two can never develop different business
 * rules. `config-error` is a safe fallback produced instead of throwing.
 */
export interface StatusSnapshot {
	kind: "ready" | "config-error";
	now: number;
	overview: StatusOverview;
	providers: ProviderStatus[];
}

/**
 * Everything the snapshot needs. All sources are injected — no disk, clock,
 * environment, or network is read here, so the snapshot stays pure and testable.
 */
export interface StatusInput {
	now: number;
	sessionId: string;
	/** Session creation time (ms); when before the retention horizon, session totals are partial. */
	sessionStartedAt?: number;
	activeProfileName?: string;
	profileWarning?: string;
	/** The active, validated configuration; absent means a configuration-error snapshot. */
	config?: SearchControlConfig;
	configError?: string;
	/** Credentials already resolved against the environment. */
	credentials: ResolvedCredential[];
	/** The pruned ledger state (retained events plus compacted buckets). */
	ledger: LedgerState;
	ledgerWarning?: string;
	/** The pruned health state. */
	health: HealthState;
	healthWarning?: string;
	retentionMs?: number;
}

function emptyCounts(): GroupCounts {
	return { attempts: 0, success: 0, failure: 0, units: 0, costUsd: 0 };
}

function emptySummary(): LedgerSummary {
	return {
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

function attemptsByAliasFrom(state: LedgerState): Record<string, number[]> {
	const byAlias: Record<string, number[]> = {};
	for (const event of state.events) {
		if (event.kind !== "attempt") continue;
		(byAlias[event.alias] ??= []).push(event.at);
	}
	return byAlias;
}

/**
 * Locally recorded estimated units for one alias within an allowance's period,
 * plus whether retained accounting covers that period. Calendar periods use
 * retained events plus compacted buckets; rolling windows use retained events
 * only and are unknown when the window reaches before the retention horizon.
 */
function allowanceUsage(
	state: LedgerState,
	alias: string,
	period: UsagePeriod,
	now: number,
	retentionMs: number,
): { used: number; coverage: "complete" | "unknown" } {
	if (period.kind === "calendar-day") {
		return { used: unitsInCalendarPeriod(state, alias, now, "daily"), coverage: "complete" };
	}
	if (period.kind === "calendar-month") {
		return { used: unitsInCalendarPeriod(state, alias, now, "monthly"), coverage: "complete" };
	}
	const days = period.days ?? 0;
	const windowStart = now - days * DAY_MS;
	let used = 0;
	for (const event of state.events) {
		if (event.kind !== "attempt" || event.alias !== alias) continue;
		if (event.at >= windowStart && event.at <= now) used += event.units;
	}
	return { used, coverage: days * DAY_MS <= retentionMs ? "complete" : "unknown" };
}

function buildCredentialStatus(
	credential: ResolvedCredential,
	context: {
		inProfile: boolean;
		cooldown?: CooldownEntry;
		demoted: boolean;
		periodAttempts: number;
		ledger: LedgerState;
		now: number;
		retentionMs: number;
	},
): CredentialStatus {
	const status: CredentialStatus = {
		alias: credential.alias,
		provider: credential.provider,
		available: credential.available,
		inProfile: context.inProfile,
		eligible: credential.available && context.cooldown === undefined,
		demoted: context.demoted,
	};
	if (context.cooldown) {
		status.cooldown = {
			category: context.cooldown.category,
			enteredAt: context.cooldown.enteredAt,
			until: context.cooldown.until,
		};
	}
	if (credential.threshold !== undefined) {
		status.threshold = credential.threshold;
		status.periodAttempts = context.periodAttempts;
	}
	if (credential.allowance) {
		const { used, coverage } = allowanceUsage(
			context.ledger,
			credential.alias,
			credential.allowance.period,
			context.now,
			context.retentionMs,
		);
		const allowance: CredentialAllowanceStatus = {
			units: credential.allowance.units,
			period: credential.allowance.period,
			source: credential.allowance.source,
			estimatedUsed: used,
			coverage,
		};
		if (coverage === "complete") {
			allowance.estimatedRemaining = Math.max(0, credential.allowance.units - used);
		}
		status.allowance = allowance;
	}
	return status;
}

/**
 * Build the pure status snapshot. Never throws: a missing or malformed
 * configuration yields a `config-error` snapshot whose provider pages remain
 * navigable but report configuration unavailable. Route readiness comes from
 * the real Search Plan, so it reflects profile membership, environment
 * availability, and cooldowns rather than environment variables alone.
 */
export function buildStatusSnapshot(input: StatusInput): StatusSnapshot {
	const now = input.now;
	const retentionMs = input.retentionMs ?? DETAIL_RETENTION_MS;
	const warnings: string[] = [];
	if (input.configError) warnings.push(input.configError);
	if (input.profileWarning) warnings.push(input.profileWarning);
	if (input.ledgerWarning) warnings.push(input.ledgerWarning);
	if (input.healthWarning) warnings.push(input.healthWarning);

	const config = input.config;
	if (!config) {
		return {
			kind: "config-error",
			now,
			overview: {
				profileName: input.activeProfileName,
				providerOrder: [],
				usableRoute: false,
				quotaCondition: false,
				session: emptySummary(),
				sessionPartial: false,
				day: emptySummary(),
				month: emptySummary(),
				warnings,
			},
			providers: PROVIDERS.map((provider) => ({
				provider,
				inProfile: false,
				configurationUnavailable: true,
				routeUsable: false,
				credentials: [],
				estimate: estimateAttempt(resolveEstimators()[provider]),
				session: emptyCounts(),
				day: emptyCounts(),
				month: emptyCounts(),
			})),
		};
	}

	const profileName = input.activeProfileName ?? config.defaultProfile;
	const profile = config.profiles[profileName];
	const providerOrder: Provider[] = profile ? [...profile.providers] : [];

	const credentials = input.credentials;
	const attemptsByAlias = attemptsByAliasFrom(input.ledger);
	const cooldowns = activeCooldowns(input.health, now);
	const penalties = mergePenalties(
		penaltiesFromHealth(input.health, now),
		thresholdPenalties(credentials, attemptsByAlias, now),
	);
	const plan = profile
		? buildSearchPlan(profile, credentials, { now, attemptsByAlias, penalties })
		: [];
	const planProviders = new Set(plan.map((target) => target.provider));
	const crossedAliases = new Set(
		thresholdCrossings(credentials, attemptsByAlias, now).map((crossing) => crossing.alias),
	);

	const session = summarizeEvents(input.ledger.events, { sessionId: input.sessionId });
	const sessionPartial =
		input.sessionStartedAt !== undefined && input.sessionStartedAt < now - retentionMs;
	const day = summarizePeriodComplete(input.ledger, now, "daily");
	const month = summarizePeriodComplete(input.ledger, now, "monthly");
	// The Overview banner describes the active profile, so a quota cooldown on a
	// credential the profile cannot route is not raised here.
	const inProfileProviders = new Set(providerOrder);
	const quotaCondition = credentials.some(
		(credential) =>
			inProfileProviders.has(credential.provider) && cooldowns[credential.alias]?.category === "quota",
	);

	const providers: ProviderStatus[] = PROVIDERS.map((provider) => {
		const inProfile = profile?.providers.includes(provider) ?? false;
		const credentialStatuses = credentials
			.filter((credential) => credential.provider === provider)
			.map((credential) =>
				buildCredentialStatus(credential, {
					inProfile,
					cooldown: cooldowns[credential.alias],
					demoted: crossedAliases.has(credential.alias),
					periodAttempts: attemptsInPeriod(
						attemptsByAlias[credential.alias] ?? [],
						credential.period,
						now,
					),
					ledger: input.ledger,
					now,
					retentionMs,
				}),
			);
		return {
			provider,
			inProfile,
			configurationUnavailable: false,
			routeUsable: inProfile && planProviders.has(provider),
			credentials: credentialStatuses,
			estimate: estimateAttempt(config.estimates[provider]),
			session: session.byProvider[provider] ?? emptyCounts(),
			day: day.byProvider[provider] ?? emptyCounts(),
			month: month.byProvider[provider] ?? emptyCounts(),
		};
	});

	return {
		kind: "ready",
		now,
		overview: {
			profileName,
			providerOrder,
			usableRoute: plan.length > 0,
			quotaCondition,
			session,
			sessionPartial,
			day,
			month,
			warnings,
		},
		providers,
	};
}

/** Human-readable label for a credential's usage period. */
export function periodLabel(period: UsagePeriod): string {
	if (period.kind === "calendar-day") return "calendar-day";
	if (period.kind === "calendar-month") return "calendar-month";
	return `rolling ${period.days ?? 0} days`;
}

function formatCounts(counts: GroupCounts): string {
	return `${counts.success} ok, ${counts.failure} fail`;
}

function formatTotals(label: string, summary: LedgerSummary, partial: boolean): string {
	const suffix = partial ? " [partial: session began before the 30-day detail-retention horizon]" : "";
	return (
		`${label}: ${summary.requests} Search Requests, ${summary.attempts} Provider Attempts ` +
		`(${summary.success} succeeded, ${summary.failure} failed)${suffix}`
	);
}

function formatCredential(credential: CredentialStatus): string {
	const parts: string[] = [`${credential.alias}: ${credential.available ? "available" : "unavailable"}`];
	parts.push(credential.eligible ? "eligible" : "not eligible");
	if (credential.cooldown) {
		parts.push(
			`cooling (${credential.cooldown.category}) until ${new Date(credential.cooldown.until).toISOString()}`,
		);
	}
	if (credential.threshold !== undefined) {
		parts.push(`threshold ${credential.threshold} (${credential.periodAttempts ?? 0} attempts this period)`);
	}
	if (credential.demoted) parts.push("demoted");
	if (credential.allowance) {
		const allowance = credential.allowance;
		const remaining =
			allowance.estimatedRemaining === undefined
				? "remaining unknown"
				: `${allowance.estimatedRemaining} remaining`;
		parts.push(
			`allowance: ${allowance.estimatedUsed}/${allowance.units} units used ` +
				`(${periodLabel(allowance.period)}, ${remaining}) [estimate]`,
		);
	} else {
		parts.push("allowance: unknown (no allowance)");
	}
	return parts.join(", ");
}

/**
 * Render a snapshot as plain text. Host-independent: no TUI API, no theme, no
 * width assumptions. The RPC notification and tests use this; the future TUI
 * panel renders the same snapshot values.
 */
export function formatStatusText(snapshot: StatusSnapshot): string {
	const { overview, providers } = snapshot;
	const lines: string[] = [];
	lines.push(`Search Profile: ${overview.profileName ?? "unknown"}`);
	lines.push(
		`Provider order: ${overview.providerOrder.length > 0 ? overview.providerOrder.join(" > ") : "unknown"}`,
	);
	lines.push(`Route: ${overview.usableRoute ? "usable" : "No usable route"}`);
	if (snapshot.kind === "config-error") {
		lines.push("Configuration unavailable: provider pages report no credential state.");
	}
	if (overview.quotaCondition) {
		lines.push("Quota condition: active (observed quota cooldown; not provider-authoritative)");
	}
	for (const warning of overview.warnings) lines.push(`Warning: ${warning}`);

	lines.push("");
	lines.push("Overview:");
	lines.push(formatTotals("This session", overview.session, overview.sessionPartial));
	lines.push(formatTotals("Today", overview.day, false));
	lines.push(formatTotals("This month", overview.month, false));

	lines.push("");
	lines.push("Providers:");
	for (const provider of providers) {
		if (provider.configurationUnavailable) {
			lines.push(`- ${provider.provider}: configuration unavailable`);
			continue;
		}
		const membership = provider.inProfile ? "in profile" : "not in this profile";
		const eligibility = `${provider.credentials.filter((credential) => credential.eligible).length}/${provider.credentials.length} credentials eligible`;
		const route = provider.inProfile
			? (provider.routeUsable ? "route usable" : "No usable route")
			: "outside active profile";
		lines.push(`- ${provider.provider} (${membership}): ${eligibility}, ${route}`);
		lines.push(`  this session: ${formatCounts(provider.session)}`);
		lines.push(`  today: ${formatCounts(provider.day)}`);
		lines.push(`  this month: ${formatCounts(provider.month)}`);
		for (const credential of provider.credentials) {
			lines.push(`  - ${formatCredential(credential)}`);
		}
		lines.push(`  estimate: ${formatEstimate(provider.estimate)}`);
	}
	return lines.join("\n");
}