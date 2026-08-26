import type { SearchOptions, SearchResponse, SearchResult } from "../utils.ts";
import { cleanText, requestSignal } from "../utils.ts";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

interface ExaSearchResponse {
	results?: Array<{
		title?: string;
		url?: string;
		text?: string;
		highlights?: unknown;
	}>;
}

function normalizeHighlights(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function buildAnswer(results: ExaSearchResponse["results"]): string {
	if (!Array.isArray(results)) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		const snippet = highlights.length > 0 ? highlights.join(" ") : cleanText(item.text, 1000);
		if (!snippet) continue;
		parts.push(`${snippet}\nSource: ${item.title || `Source ${i + 1}`} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: ExaSearchResponse["results"], numResults: number): SearchResult[] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResult[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const highlights = normalizeHighlights(item.highlights);
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: highlights.length > 0 ? cleanText(highlights.join(" ")) : cleanText(item.text),
		});
		if (mapped.length >= numResults) break;
	}
	return mapped;
}

export async function searchExa(query: string, apiKey: string, options: SearchOptions): Promise<SearchResponse> {
	const numResults = Math.min(options.numResults, 100);
	const response = await fetch(EXA_SEARCH_URL, {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			type: "auto",
			numResults,
			contents: {
				text: { maxCharacters: 1000 },
				highlights: true,
			},
		}),
		signal: requestSignal(options.timeoutMs, options.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 500)}`);
	}

	const data = await response.json() as ExaSearchResponse;
	return {
		answer: buildAnswer(data.results),
		results: mapResults(data.results, numResults),
	};
}
