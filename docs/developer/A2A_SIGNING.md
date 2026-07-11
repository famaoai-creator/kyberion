# A2A Signing Operations (AA-03)

Host-internal A2A envelopes are HMAC-SHA256 signed via `libs/core/a2a-envelope-signature.ts`.

## Key resolution order

1. `KYBERION_A2A_SECRET` (env) — highest priority; use for multi-host or containerized setups.
2. `active/shared/runtime/agent-supervisor/a2a-secret` — generated once on first use (mode 0600). All host-local processes share it, so cross-process signatures verify.
3. Process-local fallback — only if the persist write fails; a warning is logged because cross-process verification will fail.

## Rotation

1. Stop runtimes (`pnpm control supervisor stop` or quiesce missions).
2. Delete `active/shared/runtime/agent-supervisor/a2a-secret` (or set a new `KYBERION_A2A_SECRET`).
3. Restart — the next signer regenerates and persists a fresh key.

In-flight messages signed with the old key will fail verification after rotation; rotate during quiet windows.

## Enforcement modes (`KYBERION_A2A_SIGNATURE`)

| Mode             | Unsigned message                                              | Invalid signature | Unknown sender                          |
| ---------------- | ------------------------------------------------------------- | ----------------- | --------------------------------------- |
| `warn` (default) | routed; recorded in the audit chain (`a2a_signature_missing`) | rejected (always) | routed; recorded (`a2a_unknown_sender`) |
| `enforce`        | rejected                                                      | rejected          | rejected                                |

Flip to `enforce` only after the audit chain shows no legitimate unsigned traffic (query for `a2a_signature_missing` / `a2a_unknown_sender` over an observation window), per the repo's warn→enforce rule.

## Scope and limits

This is a **same-host integrity identity**: any process on the host can read the shared key, so it does not defend against cross-host spoofing or a compromised local process. Public-key identity (Ed25519, per-agent keys, rotation/revocation) is roadmap **E4** and will slot in as a second `sig_alg` beside `hmac-sha256`.
