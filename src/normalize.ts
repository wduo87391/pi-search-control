import type { Provider } from "./config.ts";
import type { SearchResponse, SearchResult } from "./utils.ts";

/**
 * The common core every successful provider result exposes: title, URL, concise
 * snippet, and the identity of the provider that produced it.
 */
export interface NormalizedCore {
	title: string;
	url: string;
	snippet: string;
	provider: Provider;
}

/**
 * A result after normalization: the common core plus a provider-specific
 * extension, namespaced by provider name so Exa, Tavily, and Brave capabilities
 * are never flattened to the lowest common denominator. The extension is
 * structured data and is never rendered into model-visible text.
 */
export interface NormalizedResult extends NormalizedCore {
	extension?: Record<string, unknown>;
}

export interface NormalizedResponse {
	provider: Provider;
	answer: string;
	results: NormalizedResult[];
	/** Response-level provider-specific data, namespaced by provider name. */
	extension?: Record<string, unknown>;
}

function namespace(
	provider: Provider,
	extension: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!extension || Object.keys(extension).length === 0) return undefined;
	return { [provider]: extension };
}

/**
 * Wrap a provider response into the common core plus a provider-specific
 * extension. The provider's raw payload is not copied wholesale: adapters attach
 * only the fields the common core cannot represent, and normalization namespaces
 * them by provider. Pure.
 */
export function normalizeResponse(provider: Provider, response: SearchResponse): NormalizedResponse {
	const normalized: NormalizedResponse = {
		provider,
		answer: response.answer,
		results: response.results.map((result: SearchResult): NormalizedResult => {
			const core: NormalizedResult = {
				title: result.title,
				url: result.url,
				snippet: result.snippet,
				provider,
			};
			const extension = namespace(provider, result.extension);
			if (extension) core.extension = extension;
			return core;
		}),
	};
	const extension = namespace(provider, response.extension);
	if (extension) normalized.extension = extension;
	return normalized;
}