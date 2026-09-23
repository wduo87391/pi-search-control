# Search aggregation landscape

Researched on 2026-09-22. Prices and free allowances are snapshots, not product guarantees.

## Decision summary

Building every search adapter again would duplicate existing work. Building a **personal search control plane for standard Pi** is still justified because the reusable options do not combine all of these semantics: session-selected profiles, user-authoritative routing, multiple credential aliases, a local request/attempt ledger, quota-period-aware scheduling, and profile-specific model guidance.

Recommended reuse boundary:

1. Fork and attribute [`pi-web-lite`](https://github.com/smithyyang/pi-web-lite) under its MIT license for its Exa, Tavily, and Brave adapters and basic failure routing.
2. Build the session policy, credential scheduling, health state, ledger, commands, and prompt behavior in `pi-search-control`.
3. Do not implement an MCP transport. If MCP providers are added later, integrate through an existing MCP client/adapter.
4. Keep V1 to Exa, Tavily, and Brave. Add providers only after the control-plane model is stable.
5. The control-plane model is now implemented, and AnySearch is the first post-V1 Search Provider. Integrate its REST endpoint directly so it participates in the existing routing and accounting seams; its available MCP transport does not reopen generic MCP support.

## Existing options

### pi-web-lite

The locally installed `pi-web-lite@0.1.6` already registers one `web_search` tool and supports Exa, Tavily, Brave, and Doubao. Its `balanced` mode shuffles all provider/credential pairs; `auto` preserves provider priority and shuffles credentials within a provider; failed targets fall through to the next target.

Primary sources:

- [Repository and README](https://github.com/smithyyang/pi-web-lite)
- Local installed source: `/home/unsual/.pi/agent/npm/node_modules/pi-web-lite/src/config.ts`
- Local installed source: `/home/unsual/.pi/agent/npm/node_modules/pi-web-lite/src/search.ts`
- Local installed source: `/home/unsual/.pi/agent/npm/node_modules/pi-web-lite/src/index.ts`

Gaps relative to this project:

- provider policy is static global configuration rather than a session-selected profile;
- credentials are raw strings in one JSON file rather than named environment references;
- no request/attempt ledger, quota period, warning threshold, or health cooldown;
- no profile-specific model guidance;
- no command/status control surface;
- provider-specific result capabilities are normalized mainly for Markdown output.

Wrapping it externally is not enough because those gaps sit inside its configuration and routing boundary. It also does not expose a documented stable library API. An attributed fork is therefore less brittle than importing package-internal modules.

### oh-my-pi

[oh-my-pi](https://github.com/can1357/oh-my-pi) has a built-in `web_search` with a broad provider chain. Its documented `providers.webSearchOrder` includes Exa, Tavily, Brave, SearXNG, DuckDuckGo, and many others; its README describes keyed and keyless providers.

Primary sources:

- [Settings reference](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)
- [Environment variables](https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md)
- [Repository README](https://github.com/can1357/oh-my-pi)

This is the strongest “do not build” alternative if changing Pi distributions is acceptable. It is not a small extension for standard Pi, and its broad provider fallback does not itself establish this project's session profile and local ledger semantics. The user chose standard Pi compatibility as a hard constraint.

### MCP servers and adapters

Tavily, Exa, and Brave publish or document MCP integrations. MCP is useful as an interoperability layer, but it does not define cross-provider credential scheduling, quota accounting, result normalization, or session policy. Pi extensions can register tools and commands directly, while existing adapters can supply MCP transport later.

Primary sources:

- [Tavily MCP](https://github.com/tavily-ai/tavily-mcp)
- [Exa MCP server](https://github.com/exa-labs/exa-mcp-server)
- [Brave Search MCP server](https://github.com/brave/brave-search-mcp-server)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/)

Conclusion: MCP support is an adapter concern for a later release, not part of V1 and not a transport this project should reimplement.

## Provider facts

### Tavily

Tavily's official pricing documentation states:

- 1,000 free API credits per month;
- basic search costs 1 credit;
- advanced search costs 2 credits;
- credits reset monthly.

Its Search API has provider-specific options and returns search results intended for agent use, so a common result core should not prevent a Tavily-specific metadata block.

Sources:

- [Credits and pricing](https://docs.tavily.com/documentation/api-credits)
- [Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)

### Exa

Exa's official pricing page states that the starter plan receives $20 on sign-up and $10 each month, with no payment method required at the time researched. Standard Search is listed at $7 per 1,000 requests for up to 10 results; content and advanced modes have additional pricing.

The Search API can return text, highlights, summaries, context, entities, request cost, and other metadata. Flattening it to only title/URL/snippet would discard useful capabilities.

Sources:

- [Pricing](https://exa.ai/pricing)
- [Search API](https://docs.exa.ai/reference/search)

### Brave Search

Brave's official Search API page lists Search at $5 per 1,000 requests and includes $5 in free monthly credits. It exposes multiple result surfaces, including Web and LLM Context, and features such as Goggles, extra snippets, and schema-enriched results.

Sources:

- [Brave Search API and pricing](https://brave.com/search/api)
- [Brave API documentation](https://api.search.brave.com/app/documentation)

### AnySearch

AnySearch documents an authenticated `POST https://api.anysearch.com/v1/search` endpoint that returns a stable JSON envelope with title, URL, snippet, optional content, request ID, result count, and upstream search duration. `max_results` accepts 1–10. Optional vertical-search controls (`tag`, `zone`, `language`, and `params`) exist, but the first adapter can rely on AnySearch's automatic intent routing.

The published contract states that a successful request returns HTTP 200 with `code: 0` and `message: "success"`, while errors return a non-2xx HTTP status; the docs instruct clients to "classify errors by HTTP status and retain the request ID". No HTTP-200-with-nonzero-`code` case is documented, so the adapter keys success off `response.ok` and does not treat `code` as a second error channel.

Its public Free plan lists 1,000 requests per day and 20 QPS per key. A separately granted 2,000-request developer allowance has an unknown reset period, so it is user configuration rather than a built-in estimator assumption.

HTTP 402 means quota exhaustion. The anonymous auto-registration flow can place a generated username, password, and API key inside the 402 response message, making the complete error body sensitive even when the extension uses authenticated requests. The adapter must sanitize failures before they enter structured tool details, session persistence, or logs.

Primary sources:

- [Quick Start](https://www.anysearch.com/docs/quick-start)
- [`POST /v1/search`](https://www.anysearch.com/docs/api-endpoints/v1-search)
- [Pricing](https://www.anysearch.com/pricing)
- [FAQ](https://www.anysearch.com/faq)

Conclusion: add AnySearch as a first-class REST Search Provider after V1. Keep its anonymous tier, auto-registration flow, MCP transport, and explicit vertical capability options outside the first increment.

### DuckDuckGo

DuckDuckGo documents where its consumer search results come from, but its historical Instant Answer endpoint is not equivalent to a supported general web-results API. General DuckDuckGo integrations commonly rely on HTML scraping, browser automation, or third-party wrappers, which have a different stability and policy profile from Exa, Tavily, and Brave.

Sources:

- [DuckDuckGo API landing page](https://duckduckgo.com/api)
- [Where results come from](https://duckduckgo.com/duckduckgo-help-pages/results/sources/)

Conclusion: DuckDuckGo should not be presented as a first-class, stable API provider in V1. A future adapter must explicitly label whether it is official, scraped, browser-backed, or mediated by another service.

## What is worth building

The differentiated work is:

- session-scoped named search profiles;
- a slash-command and status-bar control surface;
- profile-specific model guidance without allowing the model to bypass user policy;
- named environment-backed credential pools;
- period-aware least-used credential scheduling;
- short-lived cross-session health cooldowns;
- separate logical request and physical provider-attempt accounting;
- privacy-preserving retention and estimated-cost rules;
- a result envelope with a common core plus provider extensions.

The work that should be reused is:

- Exa, Tavily, and Brave HTTP adapters;
- AnySearch's documented REST contract, implemented behind the same provider-adapter seam;
- Pi's extension commands, session entries, system-prompt hook, tool activation, and status UI;
- an existing MCP transport if generic MCP support is added later.

## Final build/no-build assessment

**Build, but only as a focused incremental fork.** The project would be redundant if described merely as “one `web_search` tool supporting multiple providers and keys”; `pi-web-lite` already does that, and OMP goes much further in provider breadth. It is not redundant when defined as a standard-Pi, user-authoritative search control plane with session policy and a local usage/health ledger.
