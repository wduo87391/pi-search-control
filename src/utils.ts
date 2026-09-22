export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
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
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	return message.toLowerCase().includes("abort");
}

export function formatSearchMarkdown(query: string, provider: string, id: string, response: SearchResponse): string {
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
