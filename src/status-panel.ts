import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PROVIDERS, type Provider } from "./config.ts";
import { formatEstimate } from "./estimates.ts";
import { periodLabel, type CredentialStatus, type ProviderStatus, type StatusSnapshot } from "./status.ts";
import type { GroupCounts, LedgerSummary } from "./ledger.ts";

/**
 * The subset of Pi's callback theme the panel needs. Declared with method
 * syntax so a `Theme` instance stays structurally assignable. The panel never
 * imports a theme directly; it always renders through the injected callback.
 */
export interface StatusPanelTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export interface StatusPanelOptions {
	/** Captured at open time and defensively cloned; later mutations are invisible. */
	snapshot: StatusSnapshot;
	theme: StatusPanelTheme;
	onClose: () => void;
	requestRender: () => void;
}

interface Page {
	title: string;
	build: (theme: StatusPanelTheme) => string[];
}

const PROVIDER_TITLES: Record<Provider, string> = {
	exa: "Exa",
	tavily: "Tavily",
	brave: "Brave",
	anysearch: "AnySearch",
};

const PAGE_ORDER = new Map<Provider, number>(PROVIDERS.map((provider, index) => [provider, index]));

/** Wrap a logical line to the visible width and clamp every result to it. */
function fitLine(line: string, width: number): string[] {
	if (line === "") return [""];
	if (visibleWidth(line) <= width) return [line];
	return wrapTextWithAnsi(line, width).map((wrapped) => truncateToWidth(wrapped, width));
}

function fitLines(lines: string[], width: number): string[] {
	const fitted: string[] = [];
	for (const line of lines) fitted.push(...fitLine(line, width));
	return fitted;
}

function formatCounts(counts: GroupCounts): string {
	return `${counts.success} ok, ${counts.failure} fail`;
}

function formatTotals(label: string, summary: LedgerSummary, partial: boolean): string {
	const suffix = partial ? " [partial: session began before the 30-day detail-retention horizon]" : "";
	return (
		`${label}: ${summary.requests} Search Requests, ${summary.attempts} Provider Attempts ` +
		`(${summary.success} succeeded, ${summary.failure} failed)${suffix}`
	);
}

function credentialLines(credential: CredentialStatus, theme: StatusPanelTheme): string[] {
	const muted = (text: string) => theme.fg("muted", text);
	const lines: string[] = [
		`${theme.fg("accent", "-")} ${credential.alias}: ` +
			`${credential.available ? "available" : "unavailable"}, ` +
			`${credential.eligible ? "eligible" : "not eligible"}`,
	];
	if (credential.cooldown) {
		lines.push(
			muted(
				`    cooldown: ${credential.cooldown.category} ` +
					`(until ${new Date(credential.cooldown.until).toISOString()})`,
			),
		);
	}
	lines.push(
		muted(
			credential.threshold === undefined
				? "    threshold: none"
				: `    threshold: ${credential.threshold} (${credential.periodAttempts ?? 0} attempts this period)`,
		),
	);
	lines.push(muted(`    demoted: ${credential.demoted ? "yes" : "no"}`));

	const allowance = credential.allowance;
	if (!allowance) {
		lines.push(muted("    allowance: unknown (no allowance configured) [estimate]"));
	} else {
		const remaining =
			allowance.estimatedRemaining === undefined
				? "remaining unknown (coverage incomplete)"
				: `${allowance.estimatedRemaining} remaining`;
		lines.push(
			muted(
				`    allowance: ${allowance.estimatedUsed}/${allowance.units} units used, ${remaining} ` +
					`(${periodLabel(allowance.period)}) [estimate]`,
			),
		);
	}
	return lines;
}

function providerLines(provider: ProviderStatus, theme: StatusPanelTheme): string[] {
	const heading = (text: string) => theme.bold(theme.fg("accent", text));
	const muted = (text: string) => theme.fg("muted", text);
	const lines: string[] = [heading(PROVIDER_TITLES[provider.provider])];

	if (provider.configurationUnavailable) {
		lines.push(muted("Profile membership: unknown (configuration unavailable)"));
		lines.push(theme.fg("warning", "Configuration unavailable: credential state is not shown."));
	} else {
		lines.push(muted(`Profile membership: ${provider.inProfile ? "in profile" : "not in this profile"}`));
		const route = provider.inProfile
			? provider.routeUsable
				? "route usable"
				: "No usable route"
			: "outside active profile";
		lines.push(muted(`Route: ${route}`));
	}

	lines.push(`This session: ${formatCounts(provider.session)}`);
	lines.push(`Today: ${formatCounts(provider.day)}`);
	lines.push(`This month: ${formatCounts(provider.month)}`);
	lines.push(muted(`Estimated use per attempt: ${formatEstimate(provider.estimate)}`));

	lines.push(muted("Credentials:"));
	if (provider.credentials.length === 0) {
		lines.push(muted(provider.configurationUnavailable ? "    (configuration unavailable)" : "    none configured"));
	} else {
		for (const credential of provider.credentials) lines.push(...credentialLines(credential, theme));
	}
	return lines;
}

function overviewLines(snapshot: StatusSnapshot, theme: StatusPanelTheme): string[] {
	const { overview } = snapshot;
	const heading = (text: string) => theme.bold(theme.fg("accent", text));
	const muted = (text: string) => theme.fg("muted", text);
	const lines: string[] = [heading("Overview")];
	lines.push(`Search Profile: ${overview.profileName ?? "unknown"}`);
	lines.push(
		`Provider order: ${overview.providerOrder.length > 0 ? overview.providerOrder.join(" > ") : "unknown"}`,
	);
	lines.push(
		overview.usableRoute
			? theme.fg("success", "Route: usable")
			: theme.fg("warning", "Route: No usable route"),
	);
	if (snapshot.kind === "config-error") {
		lines.push(theme.fg("warning", "Configuration unavailable: provider pages report no credential state."));
	}
	if (overview.quotaCondition) {
		lines.push(
			theme.fg("warning", "Quota condition: active (observed quota cooldown; not provider-authoritative)"),
		);
	}
	for (const warning of overview.warnings) lines.push(theme.fg("warning", `Warning: ${warning}`));

	lines.push("");
	lines.push(formatTotals("This session", overview.session, overview.sessionPartial));
	lines.push(formatTotals("Today", overview.day, false));
	lines.push(formatTotals("This month", overview.month, false));
	return lines;
}

/**
 * A temporary, keyboard-navigable status panel. It renders one immutable status
 * snapshot captured at open time, so ledger or configuration changes while it is
 * open cannot alter what it shows. It is a plain Pi TUI component: `render`
 * returns width-safe lines, `handleInput` drives page navigation, and
 * `invalidate` clears the page/width-aware cache for theme rebuilds.
 */
export class StatusPanel {
	private readonly snapshot: StatusSnapshot;
	private readonly theme: StatusPanelTheme;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private readonly pages: Page[];
	private pageIndex = 0;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private cachedPage?: number;

	constructor(options: StatusPanelOptions) {
		// Defensive copy: an already-open panel must not observe later mutation of
		// the caller's snapshot object.
		this.snapshot = structuredClone(options.snapshot);
		this.theme = options.theme;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;

		const providers = [...this.snapshot.providers].sort(
			(a, b) => (PAGE_ORDER.get(a.provider) ?? Number.MAX_SAFE_INTEGER) - (PAGE_ORDER.get(b.provider) ?? Number.MAX_SAFE_INTEGER),
		);
		this.pages = [
			{ title: "Overview", build: (theme) => overviewLines(this.snapshot, theme) },
			...providers.map((provider) => ({
				title: PROVIDER_TITLES[provider.provider],
				build: (theme: StatusPanelTheme) => providerLines(provider, theme),
			})),
		];
	}

	/** Current page index, exposed for tests and future programmatic control. */
	get activePage(): number {
		return this.pageIndex;
	}

	private tabBar(theme: StatusPanelTheme): string {
		const tabs = this.pages.map((page, index) => {
			const label = ` ${page.title} `;
			return index === this.pageIndex
				? theme.bg("selectedBg", theme.fg("accent", label))
				: theme.fg("muted", label);
		});
		return tabs.join(theme.fg("dim", "|"));
	}

	private move(delta: number): void {
		const count = this.pages.length;
		this.pageIndex = ((this.pageIndex + delta) % count + count) % count;
		this.invalidate();
		this.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.move(-1);
		}
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		if (this.cachedLines && this.cachedWidth === w && this.cachedPage === this.pageIndex) {
			return this.cachedLines;
		}
		const theme = this.theme;
		const lines: string[] = [this.tabBar(theme), ""];
		lines.push(...this.pages[this.pageIndex].build(theme));
		lines.push("");
		lines.push(theme.fg("dim", "←/→ or Tab: switch page • Esc or q: close"));
		const fitted = fitLines(lines, w);
		this.cachedLines = fitted;
		this.cachedWidth = w;
		this.cachedPage = this.pageIndex;
		return fitted;
	}

	/** Clear cached styled output; the next render rebuilds it with the current theme. */
	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.cachedPage = undefined;
	}
}