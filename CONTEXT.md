# Personal Search Control Plane

A personal control plane for choosing and governing web-search services used by Pi. It unifies policy and visibility without pretending that every search service has identical capabilities.

## Language

**Search control plane**:
The single place where search providers, credentials, usage visibility, and session search policy are managed.
_Avoid_: Search engine, metasearch engine

**Search provider**:
An external service that accepts a search request and returns web-derived results or context, such as Exa, Tavily, Brave, or AnySearch.
_Avoid_: Engine, backend, API

**Search profile**:
A named, user-selected policy containing provider order, fallback behavior, result preferences, and model guidance for a Pi session.
_Avoid_: Mode, preset, engine selection

**Provider pin**:
A user-selected, session-local constraint that temporarily narrows a Search Profile's provider order to exactly one configured Search Provider. It disables provider fallback until reset or until another Search Profile is selected, is restored with its session branch, and is never selectable by the model.
_Avoid_: Engine selection, model selection, provider override

**Configuration reload**:
The explicit `/search-reload` action that validates a complete candidate configuration before atomically swapping it in as the active configuration; on failure the previously active configuration is preserved untouched and no field of the candidate is applied.
_Avoid_: Hot reload, auto-reload, config watching

**Guidance supplement**:
An optional per-profile block of user text appended after the non-replaceable built-in guidance; it may add to but never replace the built-in safety, privacy, and policy rules.
_Avoid_: Custom prompt, system prompt, override

**Provider capability**:
A provider-specific kind of result or behavior that should remain distinguishable even when providers share a common search entry point.
_Avoid_: Special feature

**Result normalization**:
The step that wraps a provider response into the common core (title, URL, snippet, provider identity) plus a provider-specific extension, without copying the raw provider payload wholesale.
_Avoid_: Result mapping, reshaping

**Provider extension**:
The provider-specific data a normalized search result carries alongside the common core, namespaced by provider name and delivered in structured details; it is never rendered into model-visible text.
_Avoid_: Extra fields, metadata

**Credential pool**:
The user's legitimately controlled credentials available to a search provider for normal rotation and failure recovery.
_Avoid_: Free-account farm, shared key list

**Search request**:
One logical query the user or model asks the control plane to satisfy, independent of how many providers are tried.
_Avoid_: API call, tool call

**Provider attempt**:
One external request made with a specific provider credential while satisfying a search request.
_Avoid_: Search, query

**Search orchestration**:
The per-query step that routes a Search Request through the profile's ordered plan, returns the first technically successful response, falls back only on technical failure, and accounts for every attempt.
_Avoid_: Router, dispatcher, scheduler

**Usable route**:
An eligible credential belonging to a Search Provider named by the active Search Profile. A configured provider outside that profile is not a usable route for the current session.
_Avoid_: Available provider, implicit fallback

**Usage ledger**:
The control plane's local record of search requests, provider attempts, outcomes, and estimated consumption; it is not the provider's authoritative billing balance.
_Avoid_: Exact quota, billing counter

**Usage period**:
The window over which a credential's local attempt count is measured for least-used routing: a UTC calendar day, a UTC calendar month, or a trailing window of N days. A credential that declares none defaults to a calendar month.
_Avoid_: Quota, billing cycle

**Credential cooldown**:
A time-bounded, cross-session exclusion from routing entered after a credential hits a rate limit, quota exhaustion, or a transient failure; it always expires and never applies to authentication failures or aborts.
_Avoid_: Ban, disable, backoff

**Credential threshold**:
The optional per-usage-period Provider Attempt count at which a credential is demoted in routing and the user is warned by alias; crossing it lowers priority and never disables the credential.
_Avoid_: Quota limit, hard cap, budget

**Credential allowance estimate**:
A locally configured or provider-default number of request units over an explicit period, used only to estimate remaining usage. It does not demote, disable, or authorize a credential and is never a provider-authoritative balance.
_Avoid_: Credential threshold, quota, balance

**Search status panel**:
The temporary interactive TUI opened by `/search-status`, with an overview page and one diagnostic page per Search Provider. Its usage and remaining-allowance figures come from the Usage Ledger and are estimates rather than provider-authoritative balances.
_Avoid_: Dashboard, status report, command output
