import { PROVIDERS, type CredentialDeclaration, type Provider, type UsagePeriod } from "./config.ts";
import { DEFAULT_USAGE_PERIOD } from "./selection.ts";

export interface ResolvedCredential {
	provider: Provider;
	alias: string;
	apiKey: string;
	available: boolean;
	/**
	 * Active usage period, resolved from the declaration and defaulting to
	 * calendar-month when the declaration omits one. Carried on the resolved
	 * credential so the pure plan builder can scope attempt counts per period.
	 */
	period: UsagePeriod;
}

/**
 * Resolve credential declarations against an environment record.
 *
 * Pure: the environment is injected so callers pass `process.env` at the edge and
 * tests stay free of global environment mutation. A missing or blank environment
 * variable only makes that credential unavailable; it is never a load failure.
 * The resolved credential deliberately carries no environment-variable name, so
 * alias-only output cannot leak the mapping.
 */
export function resolveCredentials(
	credentials: Record<Provider, CredentialDeclaration[]>,
	env: Record<string, string | undefined>,
): ResolvedCredential[] {
	const resolved: ResolvedCredential[] = [];
	for (const provider of PROVIDERS) {
		for (const declaration of credentials[provider]) {
			const value = env[declaration.env];
			const apiKey = typeof value === "string" ? value.trim() : "";
			resolved.push({
				provider,
				alias: declaration.alias,
				apiKey,
				available: apiKey !== "",
				period: declaration.period ?? DEFAULT_USAGE_PERIOD,
			});
		}
	}
	return resolved;
}