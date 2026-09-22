import type { SearchOptions, SearchResponse, SearchResult } from "../utils.ts";
import { cleanText, requestSignal } from "../utils.ts";

const TAVILY_API_URL = "https://api.tavily.com/search";

interface TavilyResponse {
	answer?: string;
	results?: Array<{
		title?: string;
		url?: string;
		content?: string;
		score?: number;
	}>;
}

export async function searchTavily(query: string, apiKey: string, options: SearchOptions): Promise<SearchResponse> {
	const numResults = Math.min(options.numResults, 20);
	const response = await fetch(TAVILY_API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: numResults,
			search_depth: "basic",
			include_answer: true,
		}),
		signal: requestSignal(options.timeoutMs, options.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 500)}`);
	}

	const data = await response.json() as TavilyResponse;
	const results: SearchResult[] = [];
	for (const item of data.results ?? []) {
		if (!item?.title || !item?.url) continue;
		results.push({
			title: item.title,
			url: item.url,
			snippet: cleanText(item.content),
			// Tavily's relevance score is provider-specific; the common core has no
			// equivalent, so preserve it in the extension.
			...(typeof item.score === "number" ? { extension: { score: item.score } } : {}),
		});
		if (results.length >= numResults) break;
	}

	return {
		answer: typeof data.answer === "string" ? data.answer.trim() : "",
		results,
	};
}
