import { CONFIG_PATH, parseConfig, type SearchControlConfig } from "./config.ts";
import { composeGuidance } from "./guidance.ts";

/**
 * The configuration-derived state a Pi session holds while it runs. `config` is
 * the active, fully validated configuration; the remaining fields are cached
 * derivations of it. Reload replaces this whole value at once so no observer can
 * see a half-updated configuration.
 */
export interface ActiveSearchState {
	config: SearchControlConfig | undefined;
	activeProfileName: string | undefined;
	activeGuidance: string;
	profileWarning: string | undefined;
}

/** A validated candidate, or the field-naming error that rejected it. */
export type ConfigCandidate =
	| { ok: true; config: SearchControlConfig }
	| { ok: false; error: string };

/**
 * Run a raw document through the one strict parser (`parseConfig`) and capture
 * its result instead of throwing. This is the validate step: nothing here
 * touches the active state, so a rejected candidate cannot leak any field.
 */
export function loadConfigCandidate(raw: unknown, sourcePath = CONFIG_PATH): ConfigCandidate {
	try {
		return { ok: true, config: parseConfig(raw, sourcePath) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * The swap step: given an already-validated configuration, derive the next
 * active state. Pure — it never mutates `current`.
 *
 * If the previously active profile no longer exists in the candidate, fall back
 * to the candidate's `defaultProfile` and record a warning; the extension must
 * never keep pointing at a profile the new configuration does not declare.
 */
export function swapOnSuccess(
	current: ActiveSearchState,
	candidate: SearchControlConfig,
): ActiveSearchState {
	const requested = current.activeProfileName;
	let activeProfileName: string;
	let profileWarning: string | undefined;

	if (requested && candidate.profiles[requested]) {
		activeProfileName = requested;
	} else {
		activeProfileName = candidate.defaultProfile;
		profileWarning = requested ? `profile "${requested}" no longer exists` : undefined;
	}

	return {
		config: candidate,
		activeProfileName,
		activeGuidance: composeGuidance(candidate.profiles[activeProfileName]),
		profileWarning,
	};
}

/**
 * Validate-then-swap reload. Parses `raw` with the strict parser; only if the
 * whole candidate is valid does it derive and return the next state. On any
 * parse error it returns the current state unchanged (same reference) together
 * with the offending-field error, so the caller can report it without risking a
 * partial application.
 */
export function reloadActiveState(
	current: ActiveSearchState,
	raw: unknown,
	sourcePath = CONFIG_PATH,
): { state: ActiveSearchState; error?: string } {
	const candidate = loadConfigCandidate(raw, sourcePath);
	if (!candidate.ok) return { state: current, error: candidate.error };
	return { state: swapOnSuccess(current, candidate.config) };
}