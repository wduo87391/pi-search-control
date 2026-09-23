# pi-search-control requirements

Status: V1 and the AnySearch + Search Status Panel increment are implemented.

## Purpose

`pi-search-control` is a personal, user-authoritative search control plane distributed as a standard Pi extension. It gives one stable `web_search` tool a session-selected policy while centralizing provider credentials, health, local usage visibility, and provider-specific search guidance.

The project is an attributed MIT-licensed fork of `pi-web-lite`; see [ADR 0001](./adr/0001-fork-pi-web-lite-for-provider-adapters.md). The build-versus-reuse assessment is in [the landscape research](./research/search-aggregation-landscape.md).

## Goals

1. Select a complete search policy for the current Pi session with a slash command.
2. Manage Exa, Tavily, Brave, and AnySearch through one stable search tool.
3. Rotate legitimately controlled credentials predictably and recover from technical failures.
4. Distinguish user-visible search requests from billable provider attempts.
5. Show useful local usage and health information without claiming to know authoritative account balances.
6. Preserve provider-specific capabilities behind a common result core.
7. Keep secrets out of the extension configuration and tool/model output.

## Non-goals for this increment

- DuckDuckGo, SearXNG, or additional search providers beyond Exa, Tavily, Brave, and AnySearch.
- MCP server management or a new MCP transport.
- Extending or reworking the carried-over `fetch` tool. It ships unchanged from upstream because removing it would remove the model's "inspect this specific link" affordance and push URL reading into either raw-HTML `curl` or a wasteful search round-trip.
- Automatic quality judgment or multi-provider result fusion.
- Team credential sharing, permissions, or audit controls.
- Interactive secret entry or storage.
- Provider-authoritative billing reconciliation.
- A standalone dashboard.

## Search profiles

A Search Profile is selected by the user and is authoritative for one Pi session.

A profile contains:

- ordered providers;
- technical-failure fallback behavior;
- common search options;
- namespaced provider-specific options;
- result preferences;
- a built-in guidance template;
- optional user guidance appended to that template.

Requirements:

- The global configuration MUST name an existing `defaultProfile`.
- A new session MUST start with `defaultProfile`.
- Changing a profile MUST affect only the current session.
- Resuming or navigating a saved session branch MUST restore the profile selected on that branch.
- `web_search` MUST NOT expose a provider override that lets the model bypass the selected profile.
- A user MAY apply a Provider Pin that temporarily narrows the current session branch to one configured Search Provider; this is a user command, never a model-visible tool parameter.
- The package MUST provide documented example profiles such as `research`, `economy`, and `reliable`, but MUST NOT activate undeclared built-in profiles.

## Provider routing

V1 providers are Exa, Tavily, and Brave. This increment adds AnySearch as a first-class Search Provider. The fork removes the upstream Doubao adapter: it is excluded, and the Usage Ledger's estimator rules require a verifiable first-party pricing basis per provider.

AnySearch integration MUST call the authenticated REST `POST /v1/search` endpoint directly. It MUST participate in Search Profiles, credential selection, Search Orchestration, Usage Ledger accounting, health state, and Result Normalization. Existing Search Profiles MUST remain unchanged until the user explicitly adds AnySearch to their provider order. The first AnySearch increment delegates capability routing to AnySearch and sends only the query and clamped result count; `tag`, `zone`, `language`, and `params` remain outside this increment.

The AnySearch anonymous tier and HTTP 402 auto-registration flow MUST NOT be used. An AnySearch error body MUST be treated as sensitive because a 402 response can contain generated credentials; persisted or structured diagnostics may retain only sanitized status, error category, and request ID.

The upstream `fetch` tool is carried over unchanged and is not part of provider routing.

For each logical query:

1. Follow the selected profile's provider order.
2. Within a provider, select an eligible credential with the lowest local attempt count for its active usage period.
3. Break equal counts by deterministic round-robin selection.
4. Return the first technically successful response.
5. Try the next credential or provider only after a technical failure, authentication failure, timeout, service failure, or rate limit.
6. Do not trigger another provider merely because successful results appear low quality.

For a `web_search` call containing multiple queries, each query MUST route, fail over, and account independently.

### Health behavior

- Rate-limited and transiently failing credentials MUST enter a time-bounded cooldown.
- An AnySearch credential returning HTTP 402 quota exhaustion MUST enter a five-minute cooldown and Search Orchestration MUST continue to the next credential or provider.
- Cooldown state MUST be shared across Pi sessions so a new session does not immediately repeat a known failing request.
- Cooldowns MUST expire; transient failures MUST NOT permanently disable a credential.
- Missing or unavailable credentials MUST degrade only the affected provider/profile path, not prevent the extension from loading.
- Degraded state MUST be visible in status output.

Exact retry intervals and error classifications remain implementation design decisions.

## Credentials and configuration

Configuration is user-global JSON under the Pi user configuration area.

JSONC was the original choice so that comments could explain profiles, environment references, and quota periods. That rationale was withdrawn once the user's actual setup was inspected: the config file is a symlink to a sops-nix-rendered secret (`~/.pi/web-search.json -> ~/.config/sops-nix/secrets/rendered/pi-web-search.json`), so it is generated rather than hand-edited and comments would serve no purpose. Plain JSON also avoids a hand-rolled comment stripper.

Each credential declaration MUST contain:

- a stable user-defined alias;
- an environment-variable reference;
- an optional local warning threshold;
- an optional usage-period/reset definition;
- an optional Credential Allowance Estimate with an explicit unit count and period;
- optional estimator overrides.

Requirements:

- Raw API keys MUST NOT be stored in the config file, session entries, the usage ledger, tool results, status text, or logs.
- User-facing output MUST identify a credential by alias, not by key content or environment-variable name.
- Credentials reach the process as environment variables. The user's setup renders secrets through sops-nix, so exporting those rendered values into the environment is a human wiring step outside this extension's scope.
- Multiple credentials are assumed to be legitimately controlled by the user; bypassing provider account limits is not a project goal.

Known tension, unresolved: the alias-only rule means a validation error cannot tell the user which environment variable to set, even though the user authored that mapping themselves. Revisit if it proves annoying in practice; the rule exists to keep the mapping out of shared or persisted output, which may not require suppressing it in an interactive error.
- Configuration changes MUST take effect only through explicit `/search-reload` or process restart.
- `/search-reload` MUST validate a complete candidate configuration before replacing the active one.
- Failed reloads MUST preserve the last valid active configuration and report actionable validation errors.

## Usage ledger

The ledger distinguishes:

- **Search Request**: one logical query submitted to the control plane;
- **Provider Attempt**: one external API request using one provider credential.

It MUST record enough metadata to report:

- current-session request and attempt totals;
- per-provider and per-credential-alias outcomes;
- success, error category, and cooldown effects;
- per-period attempt counts;
- estimated units or cost, including estimator version/date.

Privacy and retention:

- Query text MUST NOT be stored by default.
- Per-attempt detail MUST be retained for 30 days.
- Daily/monthly aggregates MUST remain available after detailed events expire.
- The UI MUST label units, cost, and derived remaining allowance as estimates and MUST NOT present them as provider-authoritative balances.
- AnySearch's public Free plan snapshot is 1,000 requests per calendar day and MAY supply its default Credential Allowance Estimate. A user-specific promotional allowance such as 2,000 requests MUST remain a credential-level override until its reset period is known; it MUST NOT replace the provider default globally.
- Estimated remaining allowance is the configured/default allowance minus locally recorded estimated units in that allowance's explicit period, floored at zero. It is unknown when no allowance applies or retained accounting cannot cover the full period.
- Credential thresholds remain independent routing-demotion warnings; they MUST NOT be interpreted as allowances.
- Built-in provider estimators and allowances MAY be overridden by configuration because pricing and account plans change.

Threshold behavior:

- Crossing a configured local threshold MUST warn the user and lower that credential's routing priority.
- A local threshold MUST NOT hard-disable the credential by default.

## Result model

Every successful provider response MUST expose a common core suitable for rendering and model consumption, including at least:

- title;
- URL;
- concise content/snippet when available;
- provider identity.

The structured result MUST also retain provider-specific extension data when available, rather than flattening Exa, Tavily, Brave, and AnySearch to their lowest common denominator. Raw provider data need not be copied wholesale into model-visible text.

Failed fallback attempts SHOULD remain available in structured details for diagnostics without overwhelming normal search output.

## Model guidance

- `web_search` MUST remain one stable tool.
- The active profile's built-in guidance and user supplement MUST be injected for the current session.
- Mandatory safety, privacy, and policy rules MUST come from the built-in template and MUST NOT be replaceable by profile text.
- Profile guidance SHOULD explain when and how to search, how broadly to vary queries, and any provider capability relevant to result interpretation.
- Switching profiles MAY change the prompt prefix; unnecessary per-request prompt/schema churn should be avoided.

## Commands and UI

### `/search-profile [name]`

- With no name in TUI mode, show a profile selector.
- With a valid name, select it for the current session.
- Show the active profile and its provider order.
- Reject unknown or invalid profiles without changing current state.

### `/search-provider [provider|reset]`

- With no argument in TUI mode, show every Search Provider that has at least one declared credential, including providers outside the active Search Profile.
- With a configured provider name, apply a Provider Pin to the current session branch.
- While pinned, Search Orchestration MUST route only through that provider and MUST NOT fall back to another provider after failure.
- `reset` MUST remove the Provider Pin and restore the active Search Profile's ordered routing.
- Selecting a Search Profile through `/search-profile` MUST also remove the Provider Pin.
- Resuming or navigating a saved session branch MUST restore its most recent Provider Pin or reset.
- The status line and Search Status Panel MUST show both the active Search Profile and Provider Pin; route membership and usability MUST reflect the effective single-provider route.
- Configuration reload MUST reset the Provider Pin with a warning if the pinned provider no longer has a declared credential.
- Unknown providers and providers without declared credentials MUST be rejected without changing current state.

### `/search-status`

In TUI mode, open a temporary full interactive Search Status Panel rather than printing status into the transcript. The panel MUST provide:

- an Overview page followed by one page for each supported Search Provider;
- left/right arrow and Tab/Shift+Tab page navigation;
- Escape or `q` to close;
- active profile, provider order, current-session/daily/monthly request and attempt totals, and global warnings on Overview;
- profile membership, credential availability, active cooldowns, thresholds, Credential Allowance Estimates, current-session/daily/monthly success and failure counts, and estimated consumption on each provider page;
- an explicit **No usable route** warning when the active Search Profile has no eligible credential.

RPC mode MUST emit a non-interactive notification built from the same status snapshot. Pi does not execute interactive extension commands through print/JSON prompts and their UI notifications are not observable, so those modes MUST NOT attempt to open the panel or claim command output support. The pure text formatter remains available for tests and future hosts. The TUI panel MUST NOT create a transcript entry.

### `/search-reload`

Validate and atomically activate the user-global JSON configuration while preserving the previous valid configuration on failure.

### Status line

The Pi status area SHOULD show the active profile and a compact warning indicator. Detailed usage belongs in `/search-status`, not the persistent status line.

## Degraded and failure states

- The extension SHOULD load when at least one usable configured route exists.
- Profiles with missing providers or credentials MUST be marked degraded.
- A configured Search Provider outside the active Search Profile MUST NOT be used as an implicit fallback.
- If the active Search Profile has no usable route, the Search Status Panel MUST identify that state before a search is attempted.
- If no route can satisfy a query, `web_search` MUST return a concise failure summary with provider/credential aliases and error categories, never secrets, and direct an interactive user to `/search-status` for diagnostics.
- Invalid default profiles and completely unusable configurations MUST be reported clearly rather than silently replaced with an implicit policy.

## Distribution

- The extension replaces `pi-web-lite` rather than coexisting with it. Both register `web_search` and `fetch`, so installing the fork requires removing `npm:pi-web-lite` from the Pi package list first.
- The fork keeps upstream as the `upstream` git remote and retains its MIT license and attribution.

## V1 acceptance boundary

V1 is product-complete when a user can:

1. declare environment-backed Exa, Tavily, and Brave credentials and named profiles in global JSON;
2. select a profile for a Pi session and see it in the status area;
3. search through one `web_search` tool without model-level provider override;
4. observe ordered technical-failure fallback and least-used credential selection;
5. inspect request-versus-attempt counts, estimates, warnings, and cooldowns;
6. reload valid configuration without restarting and survive an invalid reload;
7. resume a session with its prior profile;
8. verify that raw keys and query text do not appear in persisted extension state.

Everything beyond this boundary required a later design decision rather than being silently included in V1.

## Provider Pin increment acceptance boundary

The Provider Pin increment is complete when a user can:

1. run `/search-provider` to select any Search Provider with a declared credential, whether or not it belongs to the active Search Profile;
2. observe all subsequent searches on that session branch route only through the pinned provider, with no cross-provider fallback;
3. run `/search-provider reset` or select a Search Profile to restore profile routing;
4. resume or navigate session branches and recover the latest pin/reset state on each branch;
5. see the active Search Profile and Provider Pin together in the status line and Search Status Panel;
6. reload configuration and receive a warning plus automatic reset when the pinned provider no longer has a declared credential; and
7. verify that `web_search` exposes no model-selectable Provider Pin or provider override.

## Next increment acceptance boundary

The AnySearch and Search Status Panel increment is complete when a user can:

1. declare an environment-backed AnySearch credential and explicitly place AnySearch in selected Search Profiles;
2. route and fall back through AnySearch using authenticated `POST /v1/search`, with result counts clamped to the provider's supported range;
3. inspect AnySearch common result fields plus sanitized, namespaced provider extensions without persisting response-borne credentials;
4. observe HTTP 402 as quota exhaustion, a five-minute credential cooldown, and fallback to the next usable route;
5. open `/search-status` in TUI mode and navigate Overview plus all provider pages with left/right or Tab keys;
6. inspect equivalent status information as an RPC notification, while print/JSON modes avoid unsupported interactive UI calls;
7. see **No usable route** when every route in the active Search Profile is unavailable or cooling down, without silently routing through a provider outside that profile;
8. distinguish locally estimated AnySearch use and remaining allowance from provider-authoritative balance data, without conflating an allowance with a Credential Threshold.
