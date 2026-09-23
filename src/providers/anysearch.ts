import type { SearchOptions, SearchResponse, SearchResult } from "../utils.ts";
import { cleanText, requestSignal } from "../utils.ts";

const ANYSEARCH_SEARCH_URL = "https://api.anysearch.com/v1/search";

/** AnySearch documents `max_results` as an inclusive 1–10 range. */
export const ANYSEARCH_MIN_RESULTS = 1;
export const ANYSEARCH_MAX_RESULTS = 10;

/**
 * Defensive bound on the preserved `content` extension. AnySearch returns
 * cleaned page content that can be arbitrarily long; the extension is carried in
 * structured details, so it is capped rather than copied unbounded. This is a
 * local bound, not a provider limit.
 */
export const ANYSEARCH_CONTENT_MAX_CHARS = 4000;

/** Clamp a requested result count to AnySearch's documented range. */
export function clampAnySearchResults(value: number): number {
	if (!Number.isFinite(value)) return ANYSEARCH_MAX_RESULTS;
	return Math.min(ANYSEARCH_MAX_RESULTS, Math.max(ANYSEARCH_MIN_RESULTS, Math.floor(value)));
}

interface AnySearchResultItem {
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
}

interface AnySearchResponse {
	/** Business result code. Success is 0; errors arrive as non-2xx HTTP statuses. */
	code?: number;
	message?: string;
	request_id?: string;
	data?: {
		results?: AnySearchResultItem[];
		metadata?: {
			total_results?: number;
			search_time_ms?: number;
		};
	};
}

/**
 * AnySearch's authenticated `POST /v1/search` adapter.
 *
 * The first increment sends only the query and a clamped result count and lets
 * AnySearch perform automatic capability routing; `tag`, `zone`, `language`, and
 * `params` stay out. The common core (title, URL, snippet) is mapped into the
 * shared `SearchResponse`; AnySearch-only fields (`content`, `request_id`,
 * `total_results`, `search_time_ms`) ride in namespaced extensions, never into
 * model-visible text.
 */
export async function searchAnySearch(
	query: string,
	apiKey: string,
	options: SearchOptions,
): Promise<SearchResponse> {
	const maxResults = clampAnySearchResults(options.numResults);
	const response = await fetch(ANYSEARCH_SEARCH_URL, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query, max_results: maxResults }),
		signal: requestSignal(options.timeoutMs, options.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`AnySearch API error ${response.status}: ${errorText.slice(0, 500)}`);
	}

	const data = await response.json() as AnySearchResponse;
	const results: SearchResult[] = [];
	for (const item of data.data?.results ?? []) {
		if (!item?.url) continue;
		const content = cleanText(item.content, ANYSEARCH_CONTENT_MAX_CHARS);
		const mapped: SearchResult = {
			title: cleanText(item.title) || item.url,
			url: item.url,
			// Only the provider's own snippet feeds the model-visible core. `content`
			// is provider-specific data and stays in the extension, never promoted
			// into the snippet, so it cannot reach model-visible markdown.
			snippet: cleanText(item.snippet),
		};
		// AnySearch uniquely returns cleaned page content; the common core has no
		// equivalent, so preserve it in the result extension.
		if (content) mapped.extension = { content };
		results.push(mapped);
		if (results.length >= maxResults) break;
	}

	const extension: Record<string, unknown> = {};
	if (typeof data.request_id === "string" && data.request_id.length > 0) {
		extension.request_id = data.request_id;
	}
	const metadata = data.data?.metadata;
	if (typeof metadata?.total_results === "number") extension.total_results = metadata.total_results;
	if (typeof metadata?.search_time_ms === "number") extension.search_time_ms = metadata.search_time_ms;

	const searchResponse: SearchResponse = { answer: "", results };
	if (Object.keys(extension).length > 0) searchResponse.extension = extension;
	return searchResponse;
}