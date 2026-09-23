import type { CredentialAllowance, Provider } from "./config.ts";

/**
 * A versioned, dated estimate rule for one Search Provider.
 *
 * Every field is a best-effort snapshot taken from the provider's published
 * pricing, never a provider-authoritative balance. `basis` records the source
 * claim so a later reader can re-verify it against the landscape research.
 */
export interface EstimatorRule {
	provider: Provider;
	version: string;
	date: string;
	unit: string;
	unitsPerAttempt: number;
	costPerUnitUsd: number;
	basis: string;
}

/** A configuration-supplied partial correction to a built-in rule. */
export interface EstimatorOverride {
	version?: string;
	date?: string;
	unit?: string;
	unitsPerAttempt?: number;
	costPerUnitUsd?: number;
	basis?: string;
}

/** Date the built-in pricing snapshots were researched (`docs/research/search-aggregation-landscape.md`). */
export const ESTIMATOR_RESEARCH_DATE = "2026-09-22";

/**
 * Date the AnySearch estimator and allowance snapshot were researched from its
 * first-party docs and pricing page. AnySearch was added after the original
 * landscape survey, so it carries its own date.
 */
export const ANYSEARCH_RESEARCH_DATE = "2026-09-23";

export const BUILT_IN_ESTIMATORS: Record<Provider, EstimatorRule> = {
	exa: {
		provider: "exa",
		version: "1",
		date: ESTIMATOR_RESEARCH_DATE,
		unit: "requests",
		unitsPerAttempt: 1,
		costPerUnitUsd: 0.007,
		basis: "$7 per 1,000 Standard Search requests (up to 10 results)",
	},
	tavily: {
		provider: "tavily",
		version: "1",
		date: ESTIMATOR_RESEARCH_DATE,
		unit: "credits",
		unitsPerAttempt: 1,
		costPerUnitUsd: 0,
		basis: "basic search 1 credit, advanced search 2 credits, 1,000 free credits per month",
	},
	brave: {
		provider: "brave",
		version: "1",
		date: ESTIMATOR_RESEARCH_DATE,
		unit: "requests",
		unitsPerAttempt: 1,
		costPerUnitUsd: 0.005,
		basis: "$5 per 1,000 Search requests",
	},
	anysearch: {
		provider: "anysearch",
		version: "1",
		date: ANYSEARCH_RESEARCH_DATE,
		unit: "requests",
		unitsPerAttempt: 1,
		costPerUnitUsd: 0,
		basis: "Public Free plan: 1,000 requests per calendar day at $0 (https://www.anysearch.com/pricing)",
	},
};

/**
 * Resolve the effective estimate rules by layering configuration overrides over
 * the built-ins. Pure: no disk, no clock, no environment.
 */
export function resolveEstimators(
	overrides: Partial<Record<Provider, EstimatorOverride>> = {},
): Record<Provider, EstimatorRule> {
	const result = {} as Record<Provider, EstimatorRule>;
	for (const provider of Object.keys(BUILT_IN_ESTIMATORS) as Provider[]) {
		const builtIn = BUILT_IN_ESTIMATORS[provider];
		const override = overrides[provider];
		result[provider] = override ? { ...builtIn, ...override, provider } : { ...builtIn };
	}
	return result;
}

/** The estimated consumption of one Provider Attempt under a rule. */
export interface Estimate {
	provider: Provider;
	units: number;
	unit: string;
	costUsd: number;
	version: string;
	date: string;
}

export function estimateAttempt(rule: EstimatorRule): Estimate {
	return {
		provider: rule.provider,
		units: rule.unitsPerAttempt,
		unit: rule.unit,
		costUsd: rule.unitsPerAttempt * rule.costPerUnitUsd,
		version: rule.version,
		date: rule.date,
	};
}

/**
 * Render an estimate for user-facing output. The literal word "estimate" and the
 * rule version and date are always present, so an estimate can never be mistaken
 * for a provider balance.
 */
export function formatEstimate(estimate: Estimate): string {
	const cost = estimate.costUsd > 0 ? ` (~$${estimate.costUsd.toFixed(4)})` : "";
	return `${estimate.units} ${estimate.unit}${cost} [estimate; rule v${estimate.version}, ${estimate.date}]`;
}

/**
 * A provider-default Credential Allowance Estimate: an estimated unit count over
 * an explicit period, plus the first-party basis it was taken from. An allowance
 * is display-only and never feeds routing.
 */
export interface AllowanceRule {
	units: number;
	period: CredentialAllowance["period"];
	version: string;
	date: string;
	basis: string;
}

/** A resolved allowance, distinguishing a provider default from a user override. */
export interface ResolvedAllowance extends AllowanceRule {
	source: "credential" | "provider-default";
}

/**
 * Built-in Credential Allowance Estimates. Only providers whose public plan
 * publishes a known, resettable allowance get one; a provider without an entry
 * has no built-in allowance.
 */
export const BUILT_IN_ALLOWANCES: Partial<Record<Provider, AllowanceRule>> = {
	anysearch: {
		units: 1000,
		period: { kind: "calendar-day" },
		version: "1",
		date: ANYSEARCH_RESEARCH_DATE,
		basis: "Public Free plan: 1,000 requests per calendar day (https://www.anysearch.com/pricing)",
	},
};

/**
 * Resolve a credential's allowance: the user's override when declared, otherwise
 * the provider default. Returns `undefined` when neither exists. Pure. An
 * override keeps the provider's basis metadata so the estimate still points at
 * its first-party source; a provider with no built-in basis records that the
 * allowance is user-declared.
 */
export function resolveAllowance(
	provider: Provider,
	override?: CredentialAllowance,
): ResolvedAllowance | undefined {
	const base = BUILT_IN_ALLOWANCES[provider];
	if (!override) return base ? { ...base, source: "provider-default" } : undefined;
	return {
		units: override.units,
		period: override.period,
		version: base?.version ?? "user",
		date: base?.date ?? ESTIMATOR_RESEARCH_DATE,
		basis: base?.basis ?? "user-declared allowance",
		source: "credential",
	};
}