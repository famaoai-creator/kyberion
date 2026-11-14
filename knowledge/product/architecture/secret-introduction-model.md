---
title: Secret Introduction Model
category: Architecture
tags: [architecture, secrets, approvals, surfaces, governance]
importance: 8
author: Ecosystem Architect
last_updated: 2026-11-13
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

Canonical helpers live in `libs/core/secret/secret-identity.ts`.

## Dual-write apply

`applySecretIntroduction` always:

1. `storeSecret(service, account, value)` via secret-bridge (macOS Keychain, Windows Credential Manager, or the explicitly enabled file vault).
2. `storeConnectionDocument(serviceId, { [field]: value })` so secret-guard consumers resolve immediately.
3. Records approval apply result (fingerprint only — never the value).

`secret-guard.getSecret` also falls through to `fetchSecretSync` for keychain-only legacy entries.

Declared identities resolve their governed connection lazily before the platform's OS-native secret manager.
Imports skip encrypted connection decryption. Explicit CLI operations memoize
Keychain reads, including refusal, within the operation; decrypt never creates a
replacement encryption master. macOS Keychain writes attach an access list that trusts
`/usr/bin/security` (the reader), so launchd / non-interactive reads need no prompt. An
existing item keeps its ACL on update and only a binary it trusts may delete it, so a
rewrite first deletes it with `security` (refusal leaves it untouched), then adds it once.
Trade-off: trusting `/usr/bin/security` means any process running as the same macOS user can
read the item without a prompt — intended, so launchd jobs (e.g. `backup-daily`) can read it
unattended. Values must be single-line (`security -w` returns multi-line values hex-encoded);
a write that would fail that check is refused before the existing entry is touched.

## Flow

```
Concierge / CLI propose  →  approval-store (secret_mutation, no value)
Chronos / kyberion approve  →  status=approved
Concierge / CLI collect value  →  dual-write  →  status=applied
```

Low-risk local sessions (`risk=low`, terminal/concierge surface) may auto-approve the request while still emitting an audit record, then proceed immediately to collect.

## Internal multi-account material storage

`secret-guard.ts` provides internal `storeLocalAccountMaterial` and
`loadLocalAccountMaterial` primitives. The address contains service, binding,
explicit person/tenant owner, and an immutable random generation. Bytes live
under `knowledge/personal/connections/accounts/<identity-hash>/<generation>.json`;
the reserved directory is excluded from ambient service-secret discovery.
Each write is AES-256-GCM encrypted with the **existing** connection-encryption
key, even when legacy connection encryption is disabled. A missing, refused,
or unsupported key fails before writing; this path never creates a key. Reads
require the exact address and verify its encrypted identity and generation;
there is no default account or plaintext fallback. The separate encrypted
`registration.json` records the approved current generation and any unfinished
apply claim; it is not an ambient credential alias.
The existing production encryption-key backend is macOS Keychain only. Linux
and Windows account-material writes fail closed; tests inject a synthetic key.
This change does not add another key backend or provision cross-platform keys.

This is material storage, not an authority store. Tenant execution and plugin
callers cannot invoke it; the local caller still needs existing secure-io file
permissions. Declaring an owner in a material address proves no ownership and
grants no credential use. Writing a new generation does not revoke old ones;
a future admitted broker must pin and revalidate the selected current generation,
binding, owner, task identity, allocation and approval before every use.

**Account introduction:** the Concierge account collector uses these primitives
after an exact owner-approved review. The review binds the existing connection,
its service token references, owner, current generation and broker configuration.
Values are collected after approval and never appear in the review. A durable
pending registration fences interrupted applies, including uncertain external
provisioning outcomes. Organization accounts use an explicitly configured writer
with compare-and-swap generation semantics; personal accounts remain local.
The service-wide introduction flow above remains separate.

Runtime reads of local personal account generations are not wired to credential
allocation. No new exact-material read capability, tenantless execution, session
collector or CLI account collector is introduced. No real keys, secrets, grants,
ownership records or migrations are changed by installing this code. The
[service integration guide](../orchestration/service-integration-guide.md#register-a-token-for-an-existing-account)
describes the setup prerequisites and recovery limits.

## Prohibitions

- Do not put secret values in ADF, mission prompts, MCP tools, approval JSON, or Chronos review payloads.
- Do not add an unrestricted MCP `secret.set`.
- Do not use playground live `secret:set` with a value.
- Do not log or return the secret value from Concierge apply responses.

## Related

- [Credential lifecycle, allocation, and execution](./api-credential-proof-boundary.md): registration, tenant allocation, task binding, selection, and proof are independent decisions. Introduction approval authorizes storage, not use by every tenant.
- [secret-mutation-approval-model.md](./secret-mutation-approval-model.md)
- `libs/core/secret/secret-introduction.ts`
- `scripts/secret_introduce.ts`
