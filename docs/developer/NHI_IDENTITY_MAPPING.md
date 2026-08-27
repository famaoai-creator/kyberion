# NHI identity: internal model ⇄ external standards

> **Purpose**: show that Kyberion's internal Non-Human Identity (NHI) model is _projectable_ onto the 2026 industry vocabulary — not to implement any of these protocols. Interop is deliberately deferred until a requirement asks for it (NI-05 §3, plan [ARTIFACT_AGENT_LIFECYCLE_NHI_PLAN_2026-07-26](./improvement-plans-archive/2026-07/ARTIFACT_AGENT_LIFECYCLE_NHI_PLAN_2026-07-26.ja.md)). This page is the seam: if the internal shapes below stop mapping cleanly, that is a design regression worth catching early.

## The four mappings

| Internal (implemented)                                                                           | External analogue                                                 | Projection                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`nhi_id`** — `kyberion://agent/<org>/<slug>` (NI-01, `libs/core/agent-identity.ts`)            | **SPIFFE ID** — `spiffe://<trust-domain>/<workload-path>`         | Same shape: URI scheme + trust domain + path. `kyberion://agent/acme/report-writer` → `spiffe://acme.kyberion/agent/report-writer`. Both are stable, non-secret, comparable identifiers; neither carries authorization on its own.   |
| **`DelegationChain`** — ordered `[{actor, team_role?, granted_scope}]` (NI-03)                   | **RFC 8693 Token Exchange** nested `act` claim                    | The chain is the flattened form of `act` nesting: element _n_ is the actor acting on behalf of element _n−1_. `user:famao → orchestrator → worker` ⇄ `{sub: worker, act: {sub: orchestrator, act: {sub: user}}}`.                    |
| **Task-scoped grant** — `{grantee_nhi_id, audience: {mission_id, task_id?}, expires_at}` (NI-04) | **RFC 8707 Resource Indicators** (audience-restricted token)      | `audience` is the internal `resource`/`aud` binding: a grant presented outside its declared mission/task is refused exactly as an audience-mismatched access token is. `expires_at` is the mandatory bounded lifetime (24h ceiling). |
| **`lifecycle_status`** — `provisioned → active → suspended → retired` (NI-01/NI-05)              | **Entra Agent ID** governance states / OWASP NHI #1 (offboarding) | Retirement is terminal and enforced at use time (NI-02 `KYBERION_NHI_ACTOR=enforce` refuses retired actors), which is what an external IdP's disable/delete would do. Orphan detection (NI-05) is the internal access-review sweep.  |

## What is deliberately NOT mapped

- **Attestation.** SPIFFE/SPIRE issues identity after attesting a workload. Kyberion registers identities administratively; the ledger records _who is accountable_ (`accountable_human_id`), not cryptographic proof of what is running. A2A integrity today is a same-host shared-secret HMAC (AA-03), not per-agent keys (E4).
- **Tokens.** There is no token format, no authorization server, no signature over grants. Grants are journal records read by `authority.resolveIdentityContext` inside one trust domain. RFC 8693/8707 are cited for their _vocabulary_, not their wire format.
- **Human identity.** `accountable_human_id` references the CO-06 workforce vocabulary; managing humans is out of scope.
- **Provider credentials.** `ANTHROPIC_API_KEY` and friends stay provider-level. Per-agent credentials are a non-goal (XP-02 env minimization).

## Where each piece lives

| Concern                           | Module                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| Identity records + journal        | `libs/core/agent-identity.ts` (`active/shared/coordination/identity/agent-identities.jsonl`) |
| Actor verification (warn→enforce) | `libs/core/nhi-actor-verification.ts` (`KYBERION_NHI_ACTOR`)                                 |
| Delegation chains + attenuation   | `libs/core/delegation-chain.ts`                                                              |
| Task-scoped grants                | `libs/core/task-scoped-grants.ts` (`active/shared/coordination/identity/task-grants.jsonl`)  |
| Offboarding, orphans, inventory   | `libs/core/nhi-lifecycle-governance.ts`                                                      |

## If interop is ever required

The order that costs least: (1) emit `nhi_id` as a SPIFFE-shaped URI alias, (2) serialize `DelegationChain` into a nested `act` claim on outbound A2A envelopes, (3) accept externally issued audience-restricted tokens as an alternative grant source in `resolveIdentityContext`. Each is an adapter at the edge; none requires changing the internal records — which is the property this page exists to keep true.
