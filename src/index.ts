import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { PROVIDERS, loadConfig, readConfigFile, type Provider, type SearchControlConfig, type SearchProfile } from "./config.ts";
import { resolveCredentials } from "./credentials.ts";
import { fetchOne } from "./fetch.ts";
import { composeGuidance } from "./guidance.ts";
import { createFileHealthStore, activeCooldowns, loadHealth } from "./health.ts";
import { createFileLedgerStore, loadLedger } from "./ledger.ts";
import { applyProviderPin, searchWithTarget } from "./search.ts";
import { reloadActiveState, type ActiveSearchState } from "./reload.ts";
import { buildStatusSnapshot, formatStatusText } from "./status.ts";
import { StatusPanel } from "./status-panel.ts";
import { createThresholdWarner } from "./thresholds.ts";
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

function providerCommandOptions(config: SearchControlConfig): Array<Provider | "reset"> {
	return [...PROVIDERS.filter((provider) => config.credentials[provider].length > 0), "reset"];
}

const PROFILE_ENTRY = "search-profile";
const PROVIDER_ENTRY = "search-provider";
const STATUS_KEY = "search-profile";

export default function (pi: ExtensionAPI) {
	let currentConfig: SearchControlConfig | undefined;
	let configError: string | undefined;
	let activeProfileName: string | undefined;
	let activeProviderPin: Provider | undefined;
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
		activeProviderPin = undefined;
		profileWarning = undefined;
		if (!currentConfig) return;

		let savedProfile: string | undefined;
		let savedPin: Provider | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === PROFILE_ENTRY) {
				const data = entry.data as { profile?: unknown } | undefined;
				if (data && typeof data.profile === "string") {
					savedProfile = data.profile;
					savedPin = undefined;
				}
			} else if (entry.customType === PROVIDER_ENTRY) {
				const data = entry.data as { provider?: unknown } | undefined;
				if (data?.provider === null) {
					savedPin = undefined;
				} else if (typeof data?.provider === "string" && PROVIDERS.includes(data.provider as Provider)) {
					savedPin = data.provider as Provider;
				}
			}
		}

		if (savedProfile) {
			if (currentConfig.profiles[savedProfile]) {
				activeProfileName = savedProfile;
			} else {
				activeProfileName = currentConfig.defaultProfile;
				profileWarning = `profile "${savedProfile}" no longer exists`;
			}
		} else {
			activeProfileName = currentConfig.defaultProfile;
		}
		if (savedPin) {
			if (currentConfig.credentials[savedPin].length > 0) {
				activeProviderPin = savedPin;
			} else {
				profileWarning = `provider pin "${savedPin}" no longer has a declared credential`;
			}
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
		if (activeProviderPin) text += ` | pinned: ${activeProviderPin}`;
		if (profile) {
			const resolved = resolveCredentials(currentConfig.credentials, process.env);
			// Route readiness must match the status panel: a credential whose
			// environment variable is missing *or* that is in an active cooldown is
			// not a usable route. Without the cooldown check the footer could claim a
			// provider is fine while the panel reports "No usable route".
			const now = Date.now();
			const cooling = activeCooldowns(loadHealth(healthStore, now).state, now);
			const effectiveProviders = applyProviderPin(profile, activeProviderPin).providers;
			const degraded = effectiveProviders.filter(
				(provider) => !resolved.some(
					(credential) => credential.provider === provider && credential.available && cooling[credential.alias] === undefined,
				)
			);
			if (degraded.length > 0) text += ` | unavailable: ${degraded.join(",")}`;
		}
		if (profileWarning) text += ` | warn: ${profileWarning}`;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	/**
	 * Collect one immutable status snapshot from the active configuration, the
	 * pruned usage ledger and health stores, and the session's own start time.
	 * All reads are best-effort; the snapshot never throws.
	 */
	function collectStatus(ctx: ExtensionContext): ReturnType<typeof buildStatusSnapshot> {
		const now = Date.now();
		const config = currentConfig;
		const credentials = config ? resolveCredentials(config.credentials, process.env) : [];
		const { state: ledger, warning: ledgerReadWarning } = loadLedger(ledgerStore, now);
		const { state: health, warning: healthReadWarning } = loadHealth(healthStore, now);
		let sessionStartedAt: number | undefined;
		try {
			const header = ctx.sessionManager.getHeader();
			if (header?.timestamp) {
				const parsed = Date.parse(header.timestamp);
				if (Number.isFinite(parsed)) sessionStartedAt = parsed;
			}
		} catch {
			// Session header is best-effort metadata; its absence just leaves the
			// session totals unmarked rather than failing the command.
		}
		return buildStatusSnapshot({
			now,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionStartedAt,
			activeProfileName: activeProfileName ?? config?.defaultProfile,
			activeProviderPin,
			profileWarning,
			config,
			configError,
			credentials,
			ledger,
			ledgerWarning: ledgerReadWarning ?? ledgerWarning,
			health,
			healthWarning: healthReadWarning ?? healthWarning,
		});
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
		return applyProviderPin(profile, activeProviderPin);
	}

	function selectProvider(provider: Provider, ctx: ExtensionContext): void {
		activeProviderPin = provider;
		if (profileWarning?.startsWith("provider pin ")) profileWarning = undefined;
		pi.appendEntry(PROVIDER_ENTRY, { provider });
		updateStatus(ctx);
		ctx.ui.notify(`Provider Pin: ${provider}`, "info");
	}

	function resetProviderPin(ctx: ExtensionContext): void {
		activeProviderPin = undefined;
		if (profileWarning?.startsWith("provider pin ")) profileWarning = undefined;
		pi.appendEntry(PROVIDER_ENTRY, { provider: null });
		updateStatus(ctx);
		ctx.ui.notify("Provider Pin reset; Search Profile routing restored.", "info");
	}

	function selectProfile(name: string, ctx: ExtensionContext): void {
		if (!currentConfig || !currentConfig.profiles[name]) {
			const available = currentConfig ? Object.keys(currentConfig.profiles).join(", ") : "none";
			ctx.ui.notify(`Unknown Search Profile "${name}". Available: ${available}`, "error");
			return;
		}
		activeProfileName = name;
		activeProviderPin = undefined;
		profileWarning = undefined;
		activeGuidance = composeGuidance(currentConfig.profiles[name]);
		pi.appendEntry(PROFILE_ENTRY, { profile: name });
		updateStatus(ctx);
		ctx.ui.notify(`Search Profile: ${name} (${currentConfig.profiles[name].providers.join(">")})`, "info");
	}

	pi.registerCommand("search-provider", {
		description: "Pin one Search Provider for this session",
		getArgumentCompletions: (prefix) => {
			if (!currentConfig) return null;
			const values = providerCommandOptions(currentConfig).filter((value) => value.startsWith(prefix));
			return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (!currentConfig) refreshConfig();
			if (!currentConfig) {
				ctx.ui.notify(`Search configuration unavailable: ${configError ?? "unknown error"}`, "error");
				return;
			}
			let requested = args.trim();
			if (!requested) {
				if (ctx.mode !== "tui") {
					const state = activeProviderPin ? `Active Provider Pin: ${activeProviderPin}.` : "No active Provider Pin.";
					ctx.ui.notify(`${state} Use /search-provider <provider|reset>.`, "info");
					return;
				}
				requested = await ctx.ui.select("Search Provider", providerCommandOptions(currentConfig)) ?? "";
				if (!requested) return;
			}
			if (requested === "reset") {
				resetProviderPin(ctx);
				return;
			}
			if (!PROVIDERS.includes(requested as Provider) || currentConfig.credentials[requested as Provider].length === 0) {
				ctx.ui.notify(`Unknown or unconfigured Search Provider "${requested}".`, "error");
				return;
			}
			selectProvider(requested as Provider, ctx);
		},
	});

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
			// Print and JSON modes have no observable command output and Pi does not
			// execute interactive commands through their prompts; do not claim support.
			if (!ctx.hasUI) return;
			const snapshot = collectStatus(ctx);
			if (ctx.mode === "tui") {
				// The temporary panel renders the same snapshot as the RPC text path.
				// It appends no session entry: opening, navigating, and closing it leave
				// the transcript untouched.
				await ctx.ui.custom((tui, theme, _keybindings, done) =>
					new StatusPanel({
						snapshot,
						theme,
						onClose: () => done(undefined),
						requestRender: () => tui.requestRender(),
					}),
				);
				return;
			}
			ctx.ui.notify(formatStatusText(snapshot), "info");
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

			const previousPin = activeProviderPin;
			const resetPin = previousPin !== undefined && state.config?.credentials[previousPin].length === 0;

			// Swap atomically: the whole next state was derived before any assignment.
			currentConfig = state.config;
			configError = undefined;
			activeProfileName = state.activeProfileName;
			activeGuidance = state.activeGuidance;
			activeProviderPin = resetPin ? undefined : previousPin;
			profileWarning = resetPin
				? `provider pin "${previousPin}" no longer has a declared credential`
				: state.profileWarning;
			if (resetPin) pi.appendEntry(PROVIDER_ENTRY, { provider: null });
			updateStatus(ctx);
			const name = state.activeProfileName ?? state.config?.defaultProfile ?? "unknown";
			if (resetPin) {
				ctx.ui.notify(
					`Search configuration reloaded. Provider Pin "${previousPin}" reset because it has no declared credential. Active Search Profile: ${name}`,
					"warning",
				);
			} else {
				ctx.ui.notify(`Search configuration reloaded. Active Search Profile: ${name}`, "info");
			}
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
					interactive: ctx.hasUI === true,
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
						? { query: result.query, error: result.error, failedAttempts: result.attempts }
						: {
							query: result.query,
							provider: result.provider,
							alias: result.alias,
							answer: result.answer,
							extension: result.extension,
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
