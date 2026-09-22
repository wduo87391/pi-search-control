export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/**
	 * Provider-specific fields the common core cannot represent. Adapters attach
	 * only what they uniquely offer; `normalizeResponse` namespaces them by
	 * provider before they reach structured details. Never rendered as text.
	 */
	extension?: Record<string, unknown>;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	/** Response-level provider-specific fields; namespaced by `normalizeResponse`. */
	extension?: Record<string, unknown>;
}

export interface SearchOptions {
	numResults: number;
	timeoutMs: number;
	signal?: AbortSignal;
}

export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function cleanText(value: unknown, max = 1000): string {
	if (typeof value !== "string") return "";
	return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean; originalLength: number } {
	if (text.length <= maxChars) return { text, truncated: false, originalLength: text.length };
	return {
		text: text.slice(0, maxChars) + `\n\n[Content truncated: showing ${maxChars} of ${text.length} characters.]`,
		truncated: true,
		originalLength: text.length,
	};
}

export function isAbortError(err: unknown): boolean {
	const name = err instanceof Error ? err.name : "";
	const message = err instanceof Error ? err.message : String(err);
	// `AbortSignal.timeout()` rejects with a `TimeoutError` whose message reads
	// "The operation was aborted due to timeout". A timeout is a technical
	// failure — the caller must fall back and cool down — so it is never an
	// abort. Matching on the message alone would misclassify every real timeout.
	if (name === "TimeoutError") return false;
	if (name === "AbortError") return true;
	return /\babort/i.test(`${name}: ${message}`) && !/timeout/i.test(message);
}

export interface MarkdownSource {
	answer: string;
	results: ReadonlyArray<{ title: string; url: string; snippet: string }>;
}

/**
 * Render the model-visible markdown from the common core only. It deliberately
 * accepts the minimal shape rather than a full provider response, so extension
 * data can never leak into the text.
 */
export function formatSearchMarkdown(query: string, provider: string, id: string, response: MarkdownSource): string {
	let output = `## Search results for: "${query}"\n\n`;
	output += `Provider: ${provider}\n`;
	output += `Credential: ${id}\n\n`;
	if (response.answer.trim()) {
		output += `### Answer\n\n${response.answer.trim()}\n\n`;
	}
	output += "### Sources\n\n";
	if (response.results.length === 0) {
		output += "No sources returned.\n";
	} else {
		for (let i = 0; i < response.results.length; i++) {
			const result = response.results[i];
			output += `${i + 1}. ${result.title}\n   ${result.url}`;
			if (result.snippet) output += `\n   ${result.snippet}`;
			output += "\n\n";
		}
	}
	return output.trim();
}
