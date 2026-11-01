---
title: API credential registration and proof boundaries
tags: [reasoning, credentials, extensibility, verification]
last_updated: 2026-11-01
---

# API credential registration and proof boundaries

Use the existing reasoning-provider descriptors and secret-introduction lifecycle when adding an API credential surface. A second provider or credential store creates drift and can bypass tenant credential binding introduced by the shared foundation.

Keep three states distinct: a secret has been introduced, a model/backend has been selected, and a bounded real API request has been verified. Key presence and a working CLI login prove neither API access nor model availability. Model IDs remain separate configuration, so one key can use multiple models permitted by its account.

Declare proof protocol, fixed endpoint, primary secret identity and model environment keys in the canonical provider descriptor. Share request/response adapters by protocol. A compatible provider is a configuration addition; a new protocol supplies a separately registered trusted adapter. Unknown protocols fail before resolving a credential or making a request.

Use only synthetic public input for credential proofs, require explicit acceptance of possible billing, bound output and duration, and disable retries, redirects and fallback. Persist metadata rather than keys, generated text or raw errors. Existing task credential ownership and egress rules still apply to every proof.
