import type { ErrorCategory } from "./ledger.ts";

/**
 * Structured provider failure. A provider adapter raises this instead of a
 * plain `Error` whenever the provider answered with a non-2xx HTTP status.
 *
 * The representation is deliberately narrow: an HTTP status, the coarse error
 * category derived from it, and an optional allowlisted request ID. It carries
 * no response-body text, so a raw body can never reach an exception message,
 * tool details, the usage ledger, health state, status diagnostics, or logs.
 * The user-facing message is generated locally from those allowlisted fields.
 */
export interface ProviderFailureInput {
	/** Locally known provider name, e.g. `anysearch`. Safe to display. */
	provider: string;
	/** The HTTP status the provider returned. */
	status: number;
	/** An allowlisted request ID parsed from the response, when one was present. */
	requestId?: string;
}

/**
 * Map an HTTP status to the ledger's coarse error category. 402 Payment
 * Required is quota exhaustion; 401/403 are authentication; 429 is a rate
 * limit; 5xx are service failures; anything else is unclassified.
 */
export function categoryForStatus(status: number): ErrorCategory {
	if (status === 402) return "quota";
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate_limit";
	if (status >= 500 && status <= 599) return "service";
	return "unknown";
}

/** Build the user-facing message from allowlisted fields only. Pure. */
export function describeProviderFailure(
	provider: string,
	status: number,
	category: ErrorCategory,
	requestId?: string,
): string {
	const base = `${provider} request failed with HTTP ${status} (${category})`;
	return requestId === undefined ? base : `${base} [request ${requestId}]`;
}

/** A non-2xx provider response reduced to safe, structured fields. */
export class ProviderFailureError extends Error {
	readonly provider: string;
	readonly status: number;
	readonly category: ErrorCategory;
	readonly requestId?: string;

	constructor(input: ProviderFailureInput) {
		const category = categoryForStatus(input.status);
		super(describeProviderFailure(input.provider, input.status, category, input.requestId));
		this.name = "ProviderFailureError";
		this.provider = input.provider;
		this.status = input.status;
		this.category = category;
		if (input.requestId !== undefined) this.requestId = input.requestId;
	}
}