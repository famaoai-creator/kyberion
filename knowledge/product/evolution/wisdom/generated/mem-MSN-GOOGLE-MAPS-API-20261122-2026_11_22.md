---
record_id: mem-MSN-GOOGLE-MAPS-API-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-GOOGLE-MAPS-API-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T03:20:49.019Z
source_branch: fix/google-maps-mcp-20261122
source_commit: 1d32f32b563934056abd292f75ba3b800b41be26
---

# Hyphenated service ids: reference names keep the raw form, stored secrets use the env-safe form — bridge at lookup, never rename references

A service secret reference is `<ID upper-cased>_<SUFFIX>` (GOOGLE-MAPS_API_KEY) across bindings, probes, setup and account-introduction, while `secret introduce` and the environment store the env-safe name (GOOGLE_MAPS_API_KEY). Renaming references breaks every binding check. The fix is a storage-only fallback in secret-guard after the exact key, and it stays safe only while env-safe ids are unique, which a catalog test enforces.

## Hint Scope

mission

## Trigger Phrases

- - Two spellings exist for a service credential:
  - the reference name, built as `serviceId.toUpperCase()_SUFFIX` by service-secret-resolver, account-introduction, credential-allocations, the personal grant and broker, and the probe and setup surfaces (ServiceValidator, surface-ux, operator-service-connection, collector-capture);
  - the canonical stored identity (`secret-identity` serviceIdToEnvPrefix), used by `pnpm kyberion secret introduce` and env vars.
    For a hyphenated id (google-maps, brave-search, github-mcp, aws-ce) these differ, so a registered key was never found (`parseEnvSecretName('GOOGLE-MAPS_API_KEY')` returns null).
- Do not rename references to the canonical form. Changing the resolver alone made every stored binding fail `[CREDENTIAL_PROVENANCE_DENIED] undeclared credential references`, and setup would report the wrong name. Instead, in secret-guard `resolveGuardedSecret`, run TIBA and SHIELD on the original key first, then look up the exact key, then fall back to the env-safe name (env, personal cache, vault record, keychain identity parse).
- The fallback is only safe while no two catalog ids share an env-safe form (a-b and a_b). A catalog test enforces that.
- Replacing a deprecated MCP package: prefer the governed direct API pattern (`auth_strategy: api_key_query`, `credential_suffixes {accessToken: [API_KEY]}`, endpoint base_url).
  - Hosts in an endpoint base_url are allowlisted automatically. A per-operation base_url on another host (places.googleapis.com) needs `manual_allowed_domains`.
  - `authQuery` is spread last, so a caller `key` cannot replace the stored key.
- Before replacing a broken integration, verify its upstream tool names from the published package (npm pack, read without running) and grep for callers.

## Recommended References

- active/missions/public/MSN-GOOGLE-MAPS-API-20261122/evidence/implementation-report.md
- active/missions/public/MSN-GOOGLE-MAPS-API-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-GOOGLE-MAPS-API-20261122/evidence/requirements-draft.json

## Evidence

- active/missions/public/MSN-GOOGLE-MAPS-API-20261122/evidence/implementation-report.md
- active/missions/public/MSN-GOOGLE-MAPS-API-20261122/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-GOOGLE-MAPS-API-20261122/evidence/requirements-draft.json

## Artifacts
