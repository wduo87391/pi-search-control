import type { SearchOptions, SearchResponse, SearchResult } from "../utils.ts";
import { cleanText, requestSignal } from "../utils.ts";
import { ProviderFailureError } from "../provider-failure.ts";

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

/**
 * Only request IDs matching this allowlist may survive a non-2xx response.
 * AnySearch error bodies are sensitive (a 402 can carry generated credentials),
 * so an allowlisted request ID is the sole body-derived value that may reach
 * diagnostics.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Return an allowlisted request ID, or `undefined` for anything else. Pure. */
export function sanitizeRequestId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * Extract at most one allowlisted request ID from a non-2xx AnySearch response.
 * The raw body is read only to locate that field and is then discarded with the
 * local binding; it is never returned, logged, persisted, or rethrown.
 */
async function readAnySearchRequestId(response: Response): Promise<string | undefined> {
	let body: string;
	try {
		body = await response.text();
	} catch {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return sanitizeRequestId((parsed as { request_id?: unknown }).request_id);
		}
	} catch {
		// A non-JSON error body yields no request ID and is discarded.
	}
	return undefined;
}

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
	/**
	 * Business result code. The published contract is that a successful request
	 * returns HTTP 200 with `code: 0` and `message: "success"`, while errors
	 * return a non-2xx HTTP status; the docs instruct clients to "classify errors
	 * by HTTP status and retain the request ID". No HTTP-200-with-nonzero-code
	 * case is documented, so the adapter keys off `response.ok`.
	 */
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
		// Treat the whole error body as sensitive: keep at most an allowlisted
		// request ID and discard the raw body immediately. The thrown message is
		// generated locally from status/category/request ID only.
		const requestId = await readAnySearchRequestId(response);
		throw new ProviderFailureError({ provider: "anysearch", status: response.status, requestId });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await response.text());
	} catch {
		// A 2xx response whose body is not JSON (a proxy/WAF page, a truncated
		// body) is a provider failure. The platform's own JSON parse error embeds
		// a snippet of the raw body, so generate a local message instead and never
		// surface the raw bytes.
		throw new Error("AnySearch returned an unreadable response body.");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("AnySearch returned an unreadable response body.");
	}
	const data = parsed as AnySearchResponse;
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
	const requestId = sanitizeRequestId(data.request_id);
	if (requestId !== undefined) extension.request_id = requestId;
	const metadata = data.data?.metadata;
	if (typeof metadata?.total_results === "number") extension.total_results = metadata.total_results;
	if (typeof metadata?.search_time_ms === "number") extension.search_time_ms = metadata.search_time_ms;

	const searchResponse: SearchResponse = { answer: "", results };
	if (Object.keys(extension).length > 0) searchResponse.extension = extension;
	return searchResponse;
}