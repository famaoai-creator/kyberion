---
record_id: mem-MSN-SURFACE-UNIFY-20261103-2026_11_03
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SURFACE-UNIFY-20261103-2026_11_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-03T17:00:03.552Z
source_branch: feat/surface-unification-20261103
source_commit: 2a6590e8e189552e95bdad61e063e0f3a709c5db
---

# Surface defects hide behind transport-based auth and unexercised default paths

Lessons from unifying Concierge/Chronos/Studio: authorize by identity+assurance not transport, exercise default-argument and aliased code paths in gates, and verify surfaces with a real sign-in E2E.

## Hint Scope

mission

## Trigger Phrases

- 1. Login config and session keys are operator-wide: read them in system scope (tenant cleared). A persisted `pnpm scope use` tenant otherwise turns the read into tenant execution and every surface reports SSO as unconfigured while the exception is swallowed.

2. Loopback origin spelling matters: Next nextUrl normalizes 127.0.0.1 to localhost; derive the request origin from the browser Host and hop /auth/start to the callback origin when loopback names differ.
3. Authorize installation-scope settings by who (installation owner, localadmin registration) and assurance (trusted loopback or fresh passkey step-up bound to the session), never by credential-less loopback alone; keep anonymous loopback for first-run bootstrap only, with sticky closure.
4. Gates must exercise the default path: tests that always pass rootDir hid that the default repository root failed the inside-root guard (Chronos /api/cost always 500). Sweep gates must follow import aliases (`frontDeskFetch as fetch`).
5. MCP plugin launch configs must set SYSTEM_ROLE and KYBERION_MCP_CALLER_ROLE or every governed tool is refused.
6. Declare surface operations once (surface-operation-registry) and expose them as both HTTP and MCP; join entity stores into one lineage-carrying graph filtered per viewer.
7. A real browser E2E (one sign-in, every rail link, entity chain by clicking, cross-surface) found four production defects unit tests had missed.

## Recommended References

- active/missions/public/MSN-SURFACE-UNIFY-20261103/evidence/distillation.md

## Evidence

- active/missions/public/MSN-SURFACE-UNIFY-20261103/evidence/distillation.md

## Artifacts
