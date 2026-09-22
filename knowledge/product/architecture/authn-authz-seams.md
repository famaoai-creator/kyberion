---
title: AuthN/AuthZ Seams — Principal Resolution and Policy Evaluation
kind: reference
scope: repository
authority: reference
phase: [execution]
tags:
  [
    authn,
    authz,
    seam,
    provider-selection,
    principal,
    oidc,
    jwks,
    agent-identity,
    fail-closed,
    audit,
  ]
owner: ecosystem_architect
last_updated: 2026-09-22
---

# AuthN/AuthZ seams

Two seam-provider-selection surfaces split "who is calling" from "may they":
`authn-principal-resolver` turns a request credential into a verified
`ResolvedPrincipal`; `authz-policy-engine` judges that principal against an
operation and resource. Both are additive — existing surface authentication
(`resolveSurfaceViewerScope`, `surface-authorization.ts`) still runs and the
seams project onto it rather than replacing it.

Code: `libs/core/authn-principal-resolver.ts` + `authn-providers.ts`,
`libs/core/authz-policy-engine.ts` + `authz-providers.ts`. Package subpaths:
`@agent/core/authn-principal-resolver`, `@agent/core/authn-providers`,
`@agent/core/authz-policy-engine`, `@agent/core/authz-providers`. Policies:
`knowledge/product/governance/seam-provider-selection/{authn-principal-resolver,authz-policy-engine}.json`.
Selection mechanics (hard filter → mission pin → operator rule → purpose
ranking → default, all audited) are shared: see [seam-provider-selection](./seam-provider-selection.md).

> **Status**: seam core only. HTTP surface wiring is a follow-up mission —
> adapters still own transport proof (loopback detection, header parsing,
> remote JWKS fetch) and feed it in through `AuthnRequest` / `deps`.

## Authenticate

```ts
import { resolveAuthnPrincipal, toSurfaceViewerScope } from '@agent/core/authn-principal-resolver';
import '@agent/core/authn-providers'; // self-registers the built-in set

const { principal, decision, attempts } = resolveAuthnPrincipal(
  {
    credential: { type: 'bearer', token: authorizationHeader.slice(7) },
    loopback: isProvenLoopback(req),          // adapter-owned proof, never client-supplied
    loopbackRole: 'readonly',                  // optional narrowing of the loopback grant
    serverTenant: tenantFromServerConfig,      // binding for unregistered remote credentials
  },
  { purpose: 'remote_human', context: { surface: 'concierge' } }
);
const scope = toSurfaceViewerScope(principal); // existing SurfaceViewerScope contract
```

- `resolveAuthnPrincipal` **throws `AuthnError`** (`status` 401/403, `code`
  `unauthenticated` / `scope_denied`) when nothing resolves — there is no
  anonymous fallback; callers map it to their transport's error shape.
- Ranked providers are tried in order. A provider returning `null` ("not my
  credential") falls through; a provider that **claims** a credential and
  rejects it terminates the chain — a forged registry/JWT-shaped token can
  never drop down to a weaker provider.
- `options.providerIds` restricts the candidate set (surface allowlists);
  `purpose` / `context` / `decisionKey` / `pin` drive the shared seam
  decision exactly like other seams.

### Built-in authn providers

| Provider          | Judges                                             | Produces                                   | Knobs                                                                                          |
| ----------------- | -------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `loopback-local`  | `request.loopback === true`                        | local operator (`localadmin`/`readonly`)   | `request.loopbackRole`                                                                          |
| `env-token`       | bearer == `KYBERION_API_TOKEN`/`KYBERION_LOCALADMIN_TOKEN` | service principal                    | `request.serverTenant` required for unregistered remote use                                    |
| `registry-token`  | bearer hashed in `chronos-access.json`             | `user:<member>` / service w/ stored scope  | `deps.registrations` injection; registry is source of truth                                    |
| `agent-context`   | in-process `request.executionContext`              | `kyberion://agent/<org>/<slug>` (NI-02)    | ambient `KYBERION_PERSONA`/`MISSION_ROLE` never authenticate a wire request                    |
| `agent-token`     | `kya1.` HMAC workload token                        | agent actor bound to NI-01 ledger entry    | `KYBERION_AGENT_TOKEN_SECRET` (secret-guard `kyberion-agent-token` fallback); `issueAgentToken`  |
| `oidc-jwt`        | JWT verified against JWKS                          | federated `user:`/`service:` principal     | `KYBERION_OIDC_ISSUER` (required), `_AUDIENCE`, `_JWKS`/`_JWKS_PATH`/`deps.jwks`, `_ALLOW_HS256` |
| `stub`            | `credential.type === 'none'` only                  | synthetic principal                        | `KYBERION_AUTHN_STUB_PRINCIPAL`; never claims a presented credential                            |

`oidc-jwt` is synchronous and **never fetches**: a surface that owns egress
must fetch the remote JWKS and pass it as `deps.jwks`.

## Authorize

```ts
import {
  authorizeWithPolicyEngine,
  assertAuthorizedWithPolicyEngine,
} from '@agent/core/authz-policy-engine';
import '@agent/core/authz-providers';

const { authorization } = authorizeWithPolicyEngine({
  principal,
  operation: { operationId: 'surface.mutation.write', effect: 'write' },
  resource: { tenantSlug, organizationId, projectId, tier },
});
// or assertAuthorizedWithPolicyEngine(...) → throws AuthzError on deny
```

Effects map to canonical permissions (`read`/`write`/`decide` →
`surface.decision.write` for `decide`); an operation's
`requiredPermissions` may add to but never remove the canonical permission.
Every verdict — including denies — is recorded to the audit chain.

### Built-in authz providers

| Provider            | Semantics                                                                            |
| ------------------- | ------------------------------------------------------------------------------------ |
| `role-scope`        | Existing `surface-authorization.ts` role + tenant/org/project/tier containment       |
| `member-membership` | Member-registry profiles; `owner`/`approver`/`viewer` → permissions; inactive/missing members deny |
| `policy-file`       | Declarative rules (`KYBERION_AUTHZ_POLICY_PATH` or `deps.policyPath`); deny rules win, no match denies |
| `allow-all`         | **Vitest only** — ineligible outside the test runner (no production fail-open)       |
| `deny-all`          | Lockdown / fail-closed floor                                                         |

Declarative policies follow `knowledge/product/schemas/authz-policy.schema.json`
(`rules[]` matching `principals` / `principal_kinds` / `operations` / `effects`
/ `resources`).

## Operating the seams

- Selection follows the shared mechanism — operator preferences live in the
  runtime overlay and are set via
  `pnpm kyberion seam select rules set --seam authn-principal-resolver …`
  (see [seam-provider-selection](./seam-provider-selection.md)). Purposes:
  `local_dev`, `remote_human`, `default_surface`, `membership`, `lockdown`, `test`.
- Mint agent workload credentials server-side:
  `issueAgentToken({ nhiId, onBehalfOf?, ttlSeconds?, tenants? }, deps)` —
  refuses unregistered / suspended / retired NI-01 identities.
- Tests: `setAuthnAuditSinkForTests` / `setAuthzAuditSinkForTests`,
  `deps.env` / `deps.jwks` / `deps.now` / `deps.policyPath` /
  `deps.memberRegistry` keep suites hermetic (see
  `libs/core/authn-principal-resolver.test.ts`).

## Surface wiring contract (when binding to HTTP)

- The adapter proves transport facts; the seam never trusts the wire:
  `loopback` and `executionContext` are adapter assertions, `serverTenant`
  comes from server config — never from client parameters (HTTP visibility
  scope rules in AGENTS.md apply).
- Parse `Authorization` into `AuthnCredential`; map `AuthnError.status` to
  the response; feed the resolved principal through `toSurfaceViewerScope`
  where the existing guard chain consumes `SurfaceViewerScope`.
