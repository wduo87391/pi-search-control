# pi-search-control requirements

Status: confirmed product design; implementation has not started.

## Purpose

`pi-search-control` is a personal, user-authoritative search control plane distributed as a standard Pi extension. It gives one stable `web_search` tool a session-selected policy while centralizing provider credentials, health, local usage visibility, and provider-specific search guidance.

The project is an attributed MIT-licensed fork of `pi-web-lite`; see [ADR 0001](./adr/0001-fork-pi-web-lite-for-provider-adapters.md). The build-versus-reuse assessment is in [the landscape research](./research/search-aggregation-landscape.md).

## Goals

1. Select a complete search policy for the current Pi session with a slash command.
2. Manage Exa, Tavily, and Brave through one stable search tool.
3. Rotate legitimately controlled credentials predictably and recover from technical failures.
4. Distinguish user-visible search requests from billable provider attempts.
5. Show useful local usage and health information without claiming to know authoritative account balances.
6. Preserve provider-specific capabilities behind a common result core.
7. Keep secrets out of the extension configuration and tool/model output.

## Non-goals for V1

- DuckDuckGo, SearXNG, or additional search providers.
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
- The package MUST provide documented example profiles such as `research`, `economy`, and `reliable`, but MUST NOT activate undeclared built-in profiles.

## Provider routing

V1 providers are Exa, Tavily, and Brave. The fork removes the upstream Doubao adapter: it is excluded from V1, and the usage ledger's estimator rules require a verifiable first-party pricing basis per provider.

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
- The UI MUST label units/cost as estimates and MUST NOT present them as provider-authoritative balances.
- Built-in provider estimators MAY be overridden by configuration because pricing and account plans change.

Threshold behavior:

- Crossing a configured local threshold MUST warn the user and lower that credential's routing priority.
- A local threshold MUST NOT hard-disable the credential by default.

## Result model

Every successful provider response MUST expose a common core suitable for rendering and model consumption, including at least:

- title;
- URL;
- concise content/snippet when available;
- provider identity.

The structured result MUST also retain provider-specific extension data when available, rather than flattening Exa, Tavily, and Brave to their lowest common denominator. Raw provider data need not be copied wholesale into model-visible text.

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

### `/search-status`

Show at least:

- active profile and provider order;
- provider availability;
- credential aliases and health/cooldown state;
- current-session request/attempt totals;
- current usage-period counts and warnings;
- estimator labels and dates.

### `/search-reload`

Validate and atomically activate the user-global JSON configuration while preserving the previous valid configuration on failure.

### Status line

The Pi status area SHOULD show the active profile and a compact warning indicator. Detailed usage belongs in `/search-status`, not the persistent status line.

## Degraded and failure states

- The extension SHOULD load when at least one usable configured route exists.
- Profiles with missing providers or credentials MUST be marked degraded.
- If no route can satisfy a query, `web_search` MUST return a concise failure summary with provider/credential aliases and error categories, never secrets.
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

Everything beyond this boundary requires a later design decision rather than being silently included in V1.
