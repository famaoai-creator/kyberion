---
title: Secret Introduction Model
category: Architecture
tags: [architecture, secrets, approvals, surfaces, governance]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-22
---

# Secret Introduction Model

## Thesis

Introducing an API key or token is a governed two-phase operation:

1. **Propose** a `secret_mutation` approval (metadata only — never the value).
2. **Collect + apply** the value only after approval, through a safe collector.

The root of trust is the approval workflow. Concierge and Chronos are surfaces; the terminal CLI is a fallback collector. No surface may become a free write path that bypasses approval for high-risk mutations.

## Why not playground / argv

`pnpm playground --actuator secret-actuator --op set --params '{"value":"..."}'` puts the secret on process argv and in temp JSON. That path is blocked for live `set` with a value. Use:

- Concierge → Settings → **Introduce secret**
- `pnpm kyberion secret introduce <serviceId> <secretKey> [--from-file PATH]`
- After a pending approval: Chronos review → Concierge apply, or `pnpm kyberion secret apply <id> --from-file PATH`

## Naming (single source)

| Layer               | Shape                     | Example                                                             |
| ------------------- | ------------------------- | ------------------------------------------------------------------- |
| Approval `target`   | `serviceId` + `secretKey` | `gemini` + `API_KEY`                                                |
| Keychain            | `service` / `account`     | `gemini` / `api_key`                                                |
| secret-guard / env  | `{SERVICE}_{SUFFIX}`      | `GEMINI_API_KEY`                                                    |
| Connection document | field = suffix snake      | `knowledge/personal/connections/gemini.json` → `{ "api_key": "…" }` |

Canonical helpers live in `libs/core/secret-identity.ts`.

## Dual-write apply

`applySecretIntroduction` always:

1. `storeSecret(service, account, value)` via secret-bridge (OS keychain / file vault).
2. `storeConnectionDocument(serviceId, { [field]: value })` so secret-guard consumers resolve immediately.
3. Records approval apply result (fingerprint only — never the value).

`secret-guard.getSecret` also falls through to `fetchSecretSync` for keychain-only legacy entries.

## Flow

```
Concierge / CLI propose  →  approval-store (secret_mutation, no value)
Chronos / kyberion approve  →  status=approved
Concierge / CLI collect value  →  dual-write  →  status=applied
```

Low-risk local sessions (`risk=low`, terminal/concierge surface) may auto-approve the request while still emitting an audit record, then proceed immediately to collect.

## Prohibitions

- Do not put secret values in ADF, mission prompts, MCP tools, approval JSON, or Chronos review payloads.
- Do not add an unrestricted MCP `secret.set`.
- Do not use playground live `secret:set` with a value.
- Do not log or return the secret value from Concierge apply responses.

## Related

- [secret-mutation-approval-model.md](./secret-mutation-approval-model.md)
- `libs/core/secret-introduction.ts`
- `scripts/secret_introduce.ts`
