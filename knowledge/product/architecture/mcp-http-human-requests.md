---
title: Default-disabled HTTP MCP human request resource server
tags: [architecture, mcp, authorization, identity, front-desk]
last_updated: 2026-10-10
---

# HTTP MCP human request resource server

## Implemented and deliberately inactive

`createMcpHttpResourceServer` is an Express router factory in shared-network.
Without `enabled: true`, it exposes no routes. It never opens a listener, changes
an existing surface, registers a provider/client, or reads a Web cookie.
No shipped runtime calls this factory. Deployment, authorization-server setup,
credential introduction, and real-provider interoperability are separate work.

The existing stdio MCP catalog and identities are unchanged. The new factory
exposes only `kyberion.request.receive`, `kyberion.request.status`, and
`kyberion.request.result`. It cannot expose pipeline, actuator, approval, member
management, or administrative tools through a generic catalog fallback.

The installed SDK remains 1.31.0, protocol 2025-11-25. Authorization design uses
the 2026-07-28 MCP authorization guidance; this is **not** a claim of full
2026-07-28 protocol support. No SDK upgrade is included.

## External authorization server; resource-server-only code

An operator-approved external OAuth authorization server must issue an access
token for the exact canonical HTTPS resource URL. Kyberion validates it; it does
not provide authorize, token, registration, revocation, or AS metadata endpoints.

Protected-resource metadata is served at the path computed by the SDK's
`getOAuthProtectedResourceMetadataUrl`, using its `metadataHandler`. It includes
the resource, pinned authorization-server issuer, minimal initial read scope, and header
bearer method. `mcpAuthRouter` is intentionally absent. Even the SDK's combined
`mcpAuthMetadataRouter` republishes AS metadata, so this factory uses the narrower
protected-resource handler instead.

Missing/invalid tokens return HTTP 401 with `WWW-Authenticate` and
`resource_metadata`. Missing operation scopes return HTTP 403 with the required
scope and metadata URL. Membership or requested-scope denials are separate 403s.

## Explicit deployment token profile

This implementation supports one bounded RFC 9068-style JWT access-token profile.
JWT is this implementation's constraint, **not a universal MCP requirement**.
Opaque tokens/introspection and provider-specific access-token profiles are not
implemented. A standards-compliant provider is not automatically compatible.

- Exact HTTPS issuer and canonical resource audience; no audience wildcard or
  second audience. An audience array is accepted only with one exact value.
- JOSE `typ` is `at+jwt` or `application/at+jwt`; ID tokens are refused.
- Signature algorithms are explicitly approved RS256 and/or ES256, with matching
  unique `kid` and algorithm in at most 16 pinned public JWKs. RSA is 2048–8192
  bits; ES256 is P-256. Private and symmetric keys are refused.
- Required bounded subject, client ID, token ID, issued-at, expiration, and
  nonempty OAuth scope. Expiration, issued-at and optional not-before are checked
  without clock-skew allowance. Signature verification precedes acceptance.
- The token is bounded to 16 KiB. Header key URLs, embedded keys/certificates,
  unknown critical parameters, and algorithm confusion are refused.
- No discovery or network JWKS fetch occurs. Key rotation requires a separately
  approved configuration/restart with the new public keys; no live rotation,
  revocation/introspection, or provider registration is claimed.

`kyberion:requests:receive` gates receiving; `kyberion:requests:read` gates status
and result. These are operation-only grants. Unknown scopes confer no authority.
Token roles, member IDs, email, and tenant claims never establish local identity.

## Strict identity and monotonic authority

After cryptographic verification, `resolveVerifiedHumanRequestIdentity` scans
the complete governed member registry. Exact issuer + subject must bind through
`external_identities` to exactly one active member. Missing, suspended, duplicate
(including active + suspended), unreadable, corrupt, or unverifiable bindings
are denied. There is no unregistered-principal or raw-subject fallback.

Effective data restrictions intersect current membership and explicit server
tenant/organization/project/tier policy, then client scope selection only narrows
them. Public/confidential tiers only; no personal or remote localadmin grant.
Receive additionally requires owner/operator membership in the selected tenant,
not the strongest role held in some other tenant. Read may use viewer/approver
membership. Restrictions must be representable by the existing scoped runtime.

The canonical human v1 marker includes a stable server-owned registry authority
namespace, member ID, and deterministic current membership fingerprint. Its
ownership hash also retains every role, tenant, organization, project and tier
restriction. Token bytes, expiry, token ID, client ID, operation-only scopes and
transport are excluded. Verified issuer/subject and transport are separately
audited with the request ID. Audit failure prevents operation invocation.

`resolveVerifiedBrowserHumanRequestIdentity` is an explicit opt-in **trusted
in-process seam** for future browser adapters. The caller must already verify a
browser session and provide its issuer/subject/expiry proof; the helper does not
authenticate structural proof by itself. The current Web login/UI is not wired
to this seam. Pairwise subjects require explicit registry alias bindings, never
email matching. Tests prove seam-level parity, not live browser/AS integration.

Legacy conversations retain byte-identical ownership hashing. Existing history
is not migrated. New canonical-human requests occupy a distinct namespace;
membership downgrades or restriction changes cannot reopen an earlier broader
transcript. Local diagnostic execution mappings cannot match canonical humans.

## Transport and durable request behavior

The adapter authenticates each accepted MCP request independently and creates a
stateless SDK server/transport per HTTP request. No process-global current user,
cookie fallback, or reusable MCP session authority exists. It validates exact
Host and allowlisted Origin without trusting forwarded headers, rejects query
parameters/credentials and ambiguous Authorization headers, and bounds JSON.
Malformed/oversized bodies and operation failures return sanitized errors.

POST is the only protected transport method. Authenticated GET/DELETE return 405;
SSE resumption, durable transport sessions and server-initiated streams are not
implemented. Allowlisted browser CORS preflights authorize no operation and
permit only the specified POST headers; cookies are never credentials. Optional
MCP tool `_meta` is accepted as protocol metadata and never used as authority.

Receive requires a UUID request ID and original creation timestamp. It delegates
to `runFrontDeskRequest`; reads delegate to `readFrontDeskRequest`. No alternate
queue, request store, approval replay, or automatic retry path is introduced.
Duplicate pending requests execute at most once; completed replay is inert;
uncertain interruption remains non-retryable under the existing receipt rules.
Status omits the saved reply; result returns it with separately verified work
state. `replyStatus: answered` never means delegated work completed.

## Evidence and remaining limits

Synthetic JWT/registry tests, local HTTP SDK tests, and actual shared-store logic
with synthetic artifact storage/lock seams
cover identity/scope denial, same-request-ID replay, cross-entry uncertainty,
concurrent users, metadata/challenges, parser errors and Host/Origin checks.
No test uses a real provider, credential, public listener, or production registry.
Repository browser regression checks do not verify this new login/OAuth path.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
[MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports),
[RFC 9068](https://www.rfc-editor.org/rfc/rfc9068),
[shared request service](./front-desk-request-service.md).
