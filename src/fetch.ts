import { requestSignal, truncateText } from "./utils.ts";

export interface FetchOptions {
	timeoutMs: number;
	maxChars: number;
	signal?: AbortSignal;
}

export interface FetchResult {
	url: string;
	title: string;
	content: string;
	truncated: boolean;
	originalLength: number;
}

interface GitHubRepo {
	name?: string;
	full_name?: string;
	description?: string | null;
	html_url?: string;
	language?: string | null;
	stargazers_count?: number;
	forks_count?: number;
	updated_at?: string;
}

interface GitHubUser {
	login?: string;
	name?: string | null;
	bio?: string | null;
	html_url?: string;
	public_repos?: number;
}

function headers(): HeadersInit {
	const headers: Record<string, string> = {
		"Accept": "application/vnd.github+json",
		"User-Agent": "pi-search-control",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	return headers;
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(Number.parseInt(num, 10)));
}

function htmlToText(html: string): { title: string; text: string } {
	const title = decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "Untitled");
	const body = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<(h[1-6]|p|li|br|div|section|article|pre|blockquote)\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	const text = decodeHtmlEntities(body)
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
	return { title, text };
}

async function fetchText(url: string, options: FetchOptions, extraHeaders?: HeadersInit): Promise<{ text: string; contentType: string }> {
	const response = await fetch(url, {
		headers: extraHeaders,
		signal: requestSignal(options.timeoutMs, options.signal),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Fetch error ${response.status} for ${url}: ${errorText.slice(0, 300)}`);
	}
	return { text: await response.text(), contentType: response.headers.get("content-type") || "" };
}

async function githubJson<T>(url: string, options: FetchOptions): Promise<T> {
	const response = await fetch(url, {
		headers: headers(),
		signal: requestSignal(options.timeoutMs, options.signal),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`GitHub API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	return await response.json() as T;
}

function formatRepo(repo: GitHubRepo): string {
	const parts = [
		`### ${repo.full_name || repo.name || "Unknown repo"}`,
		repo.html_url || "",
		repo.description || "No description.",
		`Language: ${repo.language || "unknown"} | Stars: ${repo.stargazers_count ?? 0} | Forks: ${repo.forks_count ?? 0}`,
	];
	if (repo.updated_at) parts.push(`Updated: ${repo.updated_at}`);
	return parts.filter(Boolean).join("\n");
}

async function fetchGitHubUser(owner: string, sourceUrl: string, options: FetchOptions): Promise<Omit<FetchResult, "truncated" | "originalLength">> {
	const [user, repos] = await Promise.all([
		githubJson<GitHubUser>(`https://api.github.com/users/${encodeURIComponent(owner)}`, options),
		githubJson<GitHubRepo[]>(`https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=updated&per_page=100`, options),
	]);
	const title = user.name || user.login || owner;
	let content = "";
	if (user.bio) content += `${user.bio}\n\n`;
	content += `Public repositories: ${user.public_repos ?? repos.length}\n\n`;
	content += "## Repositories\n\n";
	content += repos.map(formatRepo).join("\n\n");
	return { url: sourceUrl, title, content };
}

async function fetchGitHubRepo(owner: string, repoName: string, sourceUrl: string, options: FetchOptions): Promise<Omit<FetchResult, "truncated" | "originalLength">> {
	const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
	const repo = await githubJson<GitHubRepo>(repoUrl, options);
	let readme = "";
	try {
		readme = (await fetchText(
			`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/readme`,
			options,
			{ ...headers(), Accept: "application/vnd.github.raw" },
		)).text.trim();
	} catch {
		readme = "";
	}
	const title = repo.full_name || `${owner}/${repoName}`;
	let content = `${repo.description || "No description."}\n\n`;
	content += `Language: ${repo.language || "unknown"} | Stars: ${repo.stargazers_count ?? 0} | Forks: ${repo.forks_count ?? 0}\n`;
	if (repo.updated_at) content += `Updated: ${repo.updated_at}\n`;
	if (readme) content += `\n## README\n\n${readme}`;
	return { url: sourceUrl, title, content };
}

async function fetchGitHubBlob(owner: string, repo: string, parts: string[], sourceUrl: string, options: FetchOptions): Promise<Omit<FetchResult, "truncated" | "originalLength">> {
	const ref = parts[0];
	const filePath = parts.slice(1).join("/");
	if (!ref || !filePath) throw new Error(`Invalid GitHub blob URL: ${sourceUrl}`);
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
	const { text } = await fetchText(rawUrl, options, { "User-Agent": "pi-search-control" });
	return { url: sourceUrl, title: `${owner}/${repo}/${filePath}`, content: text };
}

async function fetchGitHub(url: URL, options: FetchOptions): Promise<Omit<FetchResult, "truncated" | "originalLength"> | null> {
	const host = url.hostname.toLowerCase();
	if (host === "raw.githubusercontent.com") {
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length >= 4) {
			const [owner, repo, ref, ...rest] = parts;
			return fetchGitHubBlob(owner, repo, [ref, ...rest], url.toString(), options);
		}
		return null;
	}
	if (host !== "github.com") return null;

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length === 1) return fetchGitHubUser(parts[0], url.toString(), options);
	if (parts.length >= 5 && parts[2] === "blob") return fetchGitHubBlob(parts[0], parts[1], parts.slice(3), url.toString(), options);
	if (parts.length >= 2) return fetchGitHubRepo(parts[0], parts[1], url.toString(), options);
	return null;
}

async function fetchGeneric(url: string, options: FetchOptions): Promise<Omit<FetchResult, "truncated" | "originalLength">> {
	const { text, contentType } = await fetchText(url, options, { "User-Agent": "pi-search-control" });
	if (contentType.includes("text/html") || /^\s*</.test(text)) {
		const converted = htmlToText(text);
		return { url, title: converted.title, content: converted.text.trim() };
	}
	return { url, title: url, content: text };
}

export async function fetchOne(url: string, options: FetchOptions): Promise<FetchResult> {
	const parsed = new URL(url);
	const base = await fetchGitHub(parsed, options) ?? await fetchGeneric(url, options);
	const truncated = truncateText(base.content, options.maxChars);
	return {
		...base,
		content: truncated.text,
		truncated: truncated.truncated,
		originalLength: truncated.originalLength,
	};
}
