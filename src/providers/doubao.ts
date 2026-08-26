import type { SearchOptions, SearchResponse, SearchResult } from "../utils.ts";
import { cleanText, requestSignal } from "../utils.ts";

const DOUBAO_SEARCH_URL = "https://open.feedcoopapi.com/search_api/web_search";

interface DoubaoResponse {
	ResponseMetadata?: {
		RequestId?: string;
		Error?: {
			CodeN?: number;
			Code?: string;
			Message?: string;
		};
	};
	Result?: {
		ResultCount?: number;
		ErrorCode?: number;
		ErrorMsg?: string;
		WebResults?: Array<{
			Title?: string;
			SiteName?: string;
			Url?: string;
			Snippet?: string;
			Summary?: string;
			Content?: string;
			PublishTime?: string;
		}>;
	};
}

function responseError(data: DoubaoResponse): string | null {
	const metaError = data.ResponseMetadata?.Error;
	if (metaError) {
		const code = metaError.Code || String(metaError.CodeN ?? "unknown");
		return `${code}: ${metaError.Message || "unknown error"}`;
	}
	const result = data.Result;
	if (result && typeof result.ErrorCode === "number" && result.ErrorCode !== 0) {
		return `${result.ErrorCode}: ${result.ErrorMsg || "unknown error"}`;
	}
	return null;
}

export async function searchDoubao(query: string, apiKey: string, options: SearchOptions): Promise<SearchResponse> {
	const numResults = Math.min(options.numResults, 50);
	const response = await fetch(DOUBAO_SEARCH_URL, {
		method: "POST",
		headers: {
			"Accept": "application/json",
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			Query: query,
			SearchType: "web",
			Count: numResults,
			Filter: {
				NeedContent: false,
				NeedUrl: true,
			},
			NeedSummary: false,
		}),
		signal: requestSignal(options.timeoutMs, options.signal),
	});

	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(`Doubao Search API error ${response.status}: ${responseText.slice(0, 500)}`);
	}

	let data: DoubaoResponse;
	try {
		data = JSON.parse(responseText) as DoubaoResponse;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Doubao Search API returned invalid JSON: ${message}`);
	}

	const error = responseError(data);
	if (error) throw new Error(`Doubao Search API error ${error}`);

	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const item of data.Result?.WebResults ?? []) {
		if (!item?.Url || seen.has(item.Url)) continue;
		results.push({
			title: item.Title || item.SiteName || item.Url,
			url: item.Url,
			snippet: cleanText(item.Summary || item.Snippet || item.Content, 1200),
		});
		seen.add(item.Url);
		if (results.length >= numResults) break;
	}

	return { answer: "", results };
}
