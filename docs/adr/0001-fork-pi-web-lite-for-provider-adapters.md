---
status: accepted
---

# Fork pi-web-lite for the provider adapters

The project will evolve as an attributed MIT-licensed fork of `pi-web-lite` rather than independently reimplementing or externally wrapping it. Its Exa, Tavily, and Brave adapters and failure-routing behavior are a useful tested base, while the desired session profiles, prompt policy, credential references, and usage ledger require changes inside the current static configuration boundary; retaining the upstream history and license makes that reuse explicit.
