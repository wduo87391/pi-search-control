import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { fetchOne } from "./fetch.ts";
import { searchOne, type FailedAttempt, type RoutedSearchResult } from "./search.ts";

function normalizeList(single: unknown, many: unknown): string[] {
	const raw = Array.isArray(many) ? many : (typeof single === "string" ? [single] : []);
	const values: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const value = item.trim();
		if (value) values.push(value);
	}
	return values;
}

function formatSearchBatch(results: Array<(RoutedSearchResult & { attempts: FailedAttempt[] }) | { query: string; error: string }>): string {
	return results.map((result) => {
		if ("error" in result) {
			return `## Search results for: "${result.query}"\n\nError: ${result.error}`;
		}
		return result.markdown;
	}).join("\n\n---\n\n").trim();
}

function compactList(items: string[], max = 4): string {
	if (items.length <= max) return items.join(", ");
	return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search Lite",
		description: "Search the web and return concise results with source links. Use multiple varied queries for broader research coverage.",
		promptSnippet: "Search the web. Prefer queries with 2-4 distinct angles for research tasks.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query. Prefer queries for multi-angle research." })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple search queries, executed independently." })),
		}),
		renderCall(args, theme) {
			const queries = normalizeList((args as { query?: unknown }).query, (args as { queries?: unknown }).queries);
			const label = queries.length <= 1 ? (queries[0] || "no query") : `${queries.length} queries`;
			return new Text(theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", label), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successful?: number;
				providerMode?: string;
				results?: Array<{ keyId?: string; sources?: unknown[]; error?: string }>;
			};
			if (isPartial) return new Text(theme.fg("accent", "searching..."), 0, 0);
			const totalSources = details?.results?.reduce((sum, item) => sum + (Array.isArray(item.sources) ? item.sources.length : 0), 0) ?? 0;
			const keys = [...new Set((details?.results ?? []).map((item) => item.keyId).filter((value): value is string => typeof value === "string"))];
			const errors = (details?.results ?? []).filter((item) => item.error).length;
			let line = theme.fg("success", `${details?.successful ?? 0}/${details?.queryCount ?? 0} queries, ${totalSources} sources`);
			line += theme.fg("muted", ` | ${details?.providerMode ?? "auto"}`);
			if (keys.length > 0) line += theme.fg("muted", ` | ${compactList(keys)}`);
			if (errors > 0) line += theme.fg("warning", ` | ${errors} errors`);
			return new Text(line, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const queries = normalizeList(params.query, params.queries);
			if (queries.length === 0) {
				throw new Error("No query provided. Use query or queries.");
			}

			const config = loadConfig();
			const results: Array<(RoutedSearchResult & { attempts: FailedAttempt[] }) | { query: string; error: string }> = [];
			const numResults = config.search.numResults;

			for (let i = 0; i < queries.length; i++) {
				const query = queries[i];
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queries.length}: ${query}` }],
					details: { phase: "search", current: i + 1, total: queries.length, query },
				});
				try {
					results.push(await searchOne(query, config, { numResults, signal }));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					results.push({ query, error: message });
				}
			}

			const successful = results.filter((result) => !("error" in result)).length;
			return {
				content: [{ type: "text", text: formatSearchBatch(results) }],
				details: {
					queries,
					queryCount: queries.length,
					successful,
					providerMode: config.provider,
					providers: config.providers,
					results: results.map((result) => "error" in result
						? { query: result.query, error: result.error }
						: {
							query: result.query,
							provider: result.provider,
							keyId: result.keyId,
							answer: result.answer,
							sources: result.results,
							failedAttempts: result.attempts,
						}),
				},
			};
		},
	});

	pi.registerTool({
		name: "fetch",
		label: "Fetch",
		description: "Fetch URL content directly and return readable text. Use this when the user asks to inspect a specific link.",
		promptSnippet: "Fetch the content of a specific URL.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs to fetch" })),
		}),
		renderCall(args, theme) {
			const urls = normalizeList((args as { url?: unknown }).url, (args as { urls?: unknown }).urls);
			const label = urls.length <= 1 ? (urls[0] || "no URL") : `${urls.length} URLs`;
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", label), 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				results?: Array<{ title?: string; truncated?: boolean; error?: string }>;
			};
			if (isPartial) return new Text(theme.fg("accent", "fetching..."), 0, 0);
			const titles = (details?.results ?? []).map((item) => item.title).filter((value): value is string => typeof value === "string" && value.length > 0);
			const truncated = (details?.results ?? []).filter((item) => item.truncated).length;
			const errors = (details?.results ?? []).filter((item) => item.error).length;
			let line = theme.fg("success", `${details?.successful ?? 0}/${details?.urlCount ?? 0} URLs`);
			if (titles.length > 0) line += theme.fg("muted", ` | ${compactList(titles, 2)}`);
			if (truncated > 0) line += theme.fg("warning", ` | ${truncated} truncated`);
			if (errors > 0) line += theme.fg("error", ` | ${errors} errors`);
			return new Text(line, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate) {
			const urls = normalizeList(params.url, params.urls);
			if (urls.length === 0) {
				throw new Error("No URL provided. Use url or urls.");
			}

			const config = loadConfig();
			const fetched = [];
			for (let i = 0; i < urls.length; i++) {
				const url = urls[i];
				onUpdate?.({
					content: [{ type: "text", text: `Fetching ${i + 1}/${urls.length}: ${url}` }],
					details: { phase: "fetch", current: i + 1, total: urls.length, url },
				});
				try {
					fetched.push(await fetchOne(url, { ...config.fetch, signal }));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					fetched.push({ url, title: url, content: `Error: ${message}`, truncated: false, originalLength: 0, error: message });
				}
			}

			const output = fetched.map((result) => {
				const header = `# ${result.title}\n${result.url}`;
				return `${header}\n\n${result.content}`;
			}).join("\n\n---\n\n");

			return {
				content: [{ type: "text", text: output.trim() }],
				details: {
					urls,
					urlCount: urls.length,
					successful: fetched.filter((result) => !("error" in result)).length,
					results: fetched.map((result) => ({
						url: result.url,
						title: result.title,
						truncated: result.truncated,
						originalLength: result.originalLength,
						error: "error" in result ? result.error : undefined,
					})),
				},
			};
		},
	});
}
