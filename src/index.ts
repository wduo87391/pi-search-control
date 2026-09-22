import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { loadConfig, PROVIDERS, readConfigFile, type SearchControlConfig, type SearchProfile } from "./config.ts";
import { resolveCredentials } from "./credentials.ts";
import { estimateAttempt, formatEstimate } from "./estimates.ts";
import { fetchOne } from "./fetch.ts";
import { composeGuidance } from "./guidance.ts";
import { createFileHealthStore, describeCooldowns, loadHealth } from "./health.ts";
import {
	createFileLedgerStore,
	loadLedger,
	summarizeEvents,
	summarizePeriod,
} from "./ledger.ts";
import { searchWithTarget } from "./search.ts";
import { reloadActiveState, type ActiveSearchState } from "./reload.ts";
import { createThresholdWarner, describeThresholds } from "./thresholds.ts";
import {
	createHealthPort,
	createLedgerPort,
	orchestrateBatch,
	type OrchestratorDeps,
	type SearchOutcome,
} from "./orchestrator.ts";

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

function formatSearchBatch(results: SearchOutcome[]): string {
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

const PROFILE_ENTRY = "search-profile";
const STATUS_KEY = "search-profile";

export default function (pi: ExtensionAPI) {
	let currentConfig: SearchControlConfig | undefined;
	let configError: string | undefined;
	let activeProfileName: string | undefined;
	// The composed guidance fragment for the active profile, recomputed only when
	// the profile changes so the prompt prefix stays stable across turns.
	let activeGuidance = "";
	let profileWarning: string | undefined;
	let ledgerWarning: string | undefined;
	let healthWarning: string | undefined;
	const thresholdWarner = createThresholdWarner();
	let thresholdWarnings: string[] = [];
	const ledgerStore = createFileLedgerStore();
	const healthStore = createFileHealthStore();
	const orchestratorDeps: OrchestratorDeps = {
		now: () => Date.now(),
		newRequestId: () => randomUUID(),
		search: searchWithTarget,
		resolveCredentials: (config) => resolveCredentials(config.credentials, process.env),
		ledger: createLedgerPort(ledgerStore, { onWarning: (warning) => { ledgerWarning = warning; } }),
		health: createHealthPort(healthStore, { onWarning: (warning) => { healthWarning = warning; } }),
		onThresholdCrossings: (crossings) => {
			thresholdWarnings.push(...thresholdWarner.warningsFor(crossings));
		},
	};

	function refreshConfig(): void {
		try {
			currentConfig = loadConfig();
			configError = undefined;
		} catch (err) {
			currentConfig = undefined;
			configError = err instanceof Error ? err.message : String(err);
		}
	}

	function restoreProfile(ctx: ExtensionContext): void {
		activeProfileName = undefined;
		profileWarning = undefined;
		if (!currentConfig) return;

		let saved: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PROFILE_ENTRY) {
				const data = entry.data as { profile?: unknown } | undefined;
				if (data && typeof data.profile === "string") saved = data.profile;
			}
		}

		if (saved) {
			if (currentConfig.profiles[saved]) {
				activeProfileName = saved;
			} else {
				activeProfileName = currentConfig.defaultProfile;
				profileWarning = `profile "${saved}" no longer exists`;
			}
		} else {
			activeProfileName = currentConfig.defaultProfile;
		}
		activeGuidance = composeGuidance(currentConfig.profiles[activeProfileName]);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!currentConfig) {
			ctx.ui.setStatus(STATUS_KEY, "search: config unavailable");
			return;
		}
		const name = activeProfileName ?? currentConfig.defaultProfile;
		const profile = currentConfig.profiles[name];
		const order = profile ? profile.providers.join(">") : "unknown";
		let text = `search: ${name} (${order})`;
		if (profile) {
			const resolved = resolveCredentials(currentConfig.credentials, process.env);
			const degraded = profile.providers.filter(
				(provider) => !resolved.some((credential) => credential.provider === provider && credential.available)
			);
			if (degraded.length > 0) text += ` | unavailable: ${degraded.join(",")}`;
		}
		if (profileWarning) text += ` | warn: ${profileWarning}`;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function formatSearchStatus(ctx: ExtensionContext): string {
		if (!currentConfig) {
			return `Search configuration unavailable: ${configError ?? "unknown error"}`;
		}
		const config = currentConfig;
		const name = activeProfileName ?? config.defaultProfile;
		const profile = config.profiles[name];
		const lines: string[] = [];
		lines.push(`Search Profile: ${name}`);
		lines.push(`Provider order: ${profile ? profile.providers.join(" > ") : "unknown"}`);
		if (profileWarning) lines.push(`Warning: ${profileWarning}`);

		const resolved = resolveCredentials(config.credentials, process.env);
		const now = Date.now();
		const healthRead = loadHealth(healthStore, now);
		const cooldowns = describeCooldowns(healthRead.state, now);
		lines.push("Providers:");
		for (const provider of PROVIDERS) {
			const credentials = resolved.filter((credential) => credential.provider === provider);
			const available = credentials.filter((credential) => credential.available).length;
			const inProfile = profile?.providers.includes(provider) ?? false;
			lines.push(
				`- ${provider}${inProfile ? "" : " (not in this profile)"}: ` +
				`${available}/${credentials.length} credentials available`
			);
			for (const credential of credentials) {
				lines.push(`  - ${credential.alias}: ${credential.available ? "available" : "unavailable"}`);
			}
		}
		if (cooldowns.length > 0) {
			lines.push("Cooldowns:");
			for (const cooldown of cooldowns) lines.push(`- ${cooldown}`);
		}

		const { state, warning } = loadLedger(ledgerStore, now);
		const attemptsByAlias: Record<string, number[]> = {};
		for (const event of state.events) {
			if (event.kind === "attempt") (attemptsByAlias[event.alias] ??= []).push(event.at);
		}
		const thresholds = describeThresholds(resolved, attemptsByAlias, now);
		if (thresholds.length > 0) {
			lines.push("Thresholds:");
			for (const threshold of thresholds) lines.push(`- ${threshold}`);
		}

		const session = summarizeEvents(state.events, { sessionId: ctx.sessionManager.getSessionId() });
		lines.push(
			`This session: ${session.requests} Search Requests, ${session.attempts} Provider Attempts ` +
			`(${session.success} succeeded, ${session.failure} failed)`
		);

		const daily = summarizePeriod(state.events, now, "daily");
		const monthly = summarizePeriod(state.events, now, "monthly");
		lines.push(`Today: ${daily.requests} requests, ${daily.attempts} attempts`);
		lines.push(`This month: ${monthly.requests} requests, ${monthly.attempts} attempts`);

		const recentDaily = state.buckets
			.filter((bucket) => bucket.granularity === "daily")
			.sort((a, b) => a.period.localeCompare(b.period))
			.slice(-5);
		for (const bucket of recentDaily) {
			lines.push(`- ${bucket.period}: ${bucket.requests} requests, ${bucket.attempts} attempts`);
		}

		lines.push("Estimates (not provider-authoritative balances):");
		for (const provider of PROVIDERS) {
			lines.push(`- ${provider}: ${formatEstimate(estimateAttempt(config.estimates[provider]))}`);
		}

		const ledgerIssue = warning ?? ledgerWarning;
		const healthIssue = healthRead.warning ?? healthWarning;
		if (ledgerIssue) lines.push(`Warning: ${ledgerIssue}`);
		if (healthIssue) lines.push(`Warning: ${healthIssue}`);
		return lines.join("\n");
	}

	function resolveProfile(): SearchProfile {
		if (!currentConfig) {
			throw new Error(`Search configuration unavailable: ${configError ?? "unknown error"}`);
		}
		const name = activeProfileName ?? currentConfig.defaultProfile;
		const profile = currentConfig.profiles[name];
		if (!profile) {
			throw new Error(`Search Profile "${name}" is not declared in profiles.`);
		}
		return profile;
	}

	function selectProfile(name: string, ctx: ExtensionContext): void {
		if (!currentConfig || !currentConfig.profiles[name]) {
			const available = currentConfig ? Object.keys(currentConfig.profiles).join(", ") : "none";
			ctx.ui.notify(`Unknown Search Profile "${name}". Available: ${available}`, "error");
			return;
		}
		activeProfileName = name;
		profileWarning = undefined;
		activeGuidance = composeGuidance(currentConfig.profiles[name]);
		pi.appendEntry(PROFILE_ENTRY, { profile: name });
		updateStatus(ctx);
		ctx.ui.notify(`Search Profile: ${name} (${currentConfig.profiles[name].providers.join(">")})`, "info");
	}

	pi.registerCommand("search-profile", {
		description: "Select the Search Profile for this session",
		getArgumentCompletions: (prefix) => {
			if (!currentConfig) return null;
			const names = Object.keys(currentConfig.profiles).filter((name) => name.startsWith(prefix));
			return names.length > 0 ? names.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (!currentConfig) refreshConfig();
			if (!currentConfig) {
				ctx.ui.notify(`Search configuration unavailable: ${configError ?? "unknown error"}`, "error");
				return;
			}

			const requested = args.trim();
			if (requested) {
				selectProfile(requested, ctx);
				return;
			}

			if (ctx.mode !== "tui") {
				const name = activeProfileName ?? currentConfig.defaultProfile;
				ctx.ui.notify(`Active Search Profile: ${name}. Use /search-profile <name> to switch.`, "info");
				return;
			}

			const names = Object.keys(currentConfig.profiles);
			const selected = await ctx.ui.select("Search Profile", names);
			if (selected) selectProfile(selected, ctx);
		},
	});

	pi.registerCommand("search-status", {
		description: "Show search provider, credential, and usage status",
		handler: async (_args, ctx) => {
			if (!currentConfig) refreshConfig();
			ctx.ui.notify(formatSearchStatus(ctx), "info");
		},
	});

	pi.registerCommand("search-reload", {
		description: "Validate and atomically activate the search configuration",
		handler: async (_args, ctx) => {
			let raw: unknown;
			try {
				raw = readConfigFile();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Reload failed: ${message}`, "error");
				return;
			}

			const current: ActiveSearchState = {
				config: currentConfig,
				activeProfileName,
				activeGuidance,
				profileWarning,
			};
			const { state, error } = reloadActiveState(current, raw);
			if (error) {
				// The previously active configuration is untouched; report the field.
				ctx.ui.notify(`Reload failed: ${error}`, "error");
				return;
			}

			// Swap atomically: the whole next state was derived before any assignment.
			currentConfig = state.config;
			configError = undefined;
			activeProfileName = state.activeProfileName;
			activeGuidance = state.activeGuidance;
			profileWarning = state.profileWarning;
			updateStatus(ctx);
			const name = state.activeProfileName ?? state.config?.defaultProfile ?? "unknown";
			ctx.ui.notify(`Search configuration reloaded. Active Search Profile: ${name}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig();
		restoreProfile(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreProfile(ctx);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeGuidance) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${activeGuidance}` };
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
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
				profileName?: string;
				results?: Array<{ alias?: string; sources?: unknown[]; error?: string }>;
			};
			if (isPartial) return new Text(theme.fg("accent", "searching..."), 0, 0);
			const totalSources = details?.results?.reduce((sum, item) => sum + (Array.isArray(item.sources) ? item.sources.length : 0), 0) ?? 0;
			const aliases = [...new Set((details?.results ?? []).map((item) => item.alias).filter((value): value is string => typeof value === "string"))];
			const errors = (details?.results ?? []).filter((item) => item.error).length;
			let line = theme.fg("success", `${details?.successful ?? 0}/${details?.queryCount ?? 0} queries, ${totalSources} sources`);
			line += theme.fg("muted", ` | ${details?.profileName ?? "none"}`);
			if (aliases.length > 0) line += theme.fg("muted", ` | ${compactList(aliases)}`);
			if (errors > 0) line += theme.fg("warning", ` | ${errors} errors`);
			return new Text(line, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const queries = normalizeList(params.query, params.queries);
			if (queries.length === 0) {
				throw new Error("No query provided. Use query or queries.");
			}

			if (!currentConfig) refreshConfig();
			const config = currentConfig;
			if (!config) {
				throw new Error(`Search configuration unavailable: ${configError ?? "unknown error"}`);
			}
			const profile = resolveProfile();
			const results = await orchestrateBatch(
				{
					queries,
					config,
					profile,
					sessionId: ctx.sessionManager.getSessionId(),
					options: { numResults: config.search.numResults, signal },
					onQuery: (current, total, query) => {
						onUpdate?.({
							content: [{ type: "text", text: `Searching ${current}/${total}: ${query}` }],
							details: { phase: "search", current, total, query },
						});
					},
				},
				orchestratorDeps,
			);

			const successful = results.filter((result) => !("error" in result)).length;
			if (thresholdWarnings.length > 0) {
				ctx.ui.notify(thresholdWarnings.join("\n"), "warning");
				thresholdWarnings = [];
			}
			return {
				content: [{ type: "text", text: formatSearchBatch(results) }],
				details: {
					queries,
					queryCount: queries.length,
					successful,
					profileName: profile.name,
					providers: profile.providers,
					results: results.map((result) => "error" in result
						? { query: result.query, error: result.error }
						: {
							query: result.query,
							provider: result.provider,
							alias: result.alias,
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

			if (!currentConfig) refreshConfig();
			const config = currentConfig;
			if (!config) {
				throw new Error(`Search configuration unavailable: ${configError ?? "unknown error"}`);
			}
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
