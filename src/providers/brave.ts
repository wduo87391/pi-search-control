import type { SearchOptions, SearchResponse, SearchResult } from "../utils.ts";
import { requestSignal } from "../utils.ts";

const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";

interface BraveContextResponse {
	grounding?: {
		generic?: Array<{
			title?: string;
			url?: string;
			snippets?: string[];
		}>;
	};
	sources?: Record<string, {
		title?: string;
		hostname?: string;
		age?: string | string[];
	}>;
}

function normalizeSnippet(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const snippet = value.trim();
	return snippet.length > 0 ? snippet : null;
}

export async function searchBrave(query: string, apiKey: string, options: SearchOptions): Promise<SearchResponse> {
	const numResults = Math.min(options.numResults, 50);
	const url = new URL(BRAVE_LLM_CONTEXT_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(numResults));
	url.searchParams.set("maximum_number_of_urls", String(numResults));

	const response = await fetch(url, {
		headers: {
			"Accept": "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
		signal: requestSignal(options.timeoutMs, options.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Brave LLM Context API error ${response.status}: ${errorText.slice(0, 500)}`);
	}

	const data = await response.json() as BraveContextResponse;
	const results: SearchResult[] = [];
	const seen = new Set<string>();

	for (const item of data.grounding?.generic ?? []) {
		if (!item?.url || seen.has(item.url)) continue;
		const snippets = (item.snippets ?? [])
			.map(normalizeSnippet)
			.filter((snippet): snippet is string => !!snippet);
		if (snippets.length === 0) continue;

		const source = data.sources?.[item.url];
		results.push({
			title: item.title || source?.title || source?.hostname || item.url,
			url: item.url,
			snippet: snippets.join("\n\n"),
		});
		seen.add(item.url);
		if (results.length >= numResults) break;
	}

	return { answer: "", results };
}
