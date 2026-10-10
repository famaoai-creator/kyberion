---
title: Shared front-desk request application service
tags: [architecture, front-desk, mcp, authorization, durability]
last_updated: 2026-10-10
---

# Shared front-desk request application service

The Web stays on Next.js. Transport adapters call common application operations;
they do not own another queue or redefine the meaning of a request result.

## Implemented boundary

`runFrontDeskRequest` owns reservation, replay, scoped conversation invocation,
completion and interruption receipts. The caller supplies a separately resolved,
already-authorized viewer. The service derives the actor, conversation key and
runtime scope from that viewer, never from request arguments.

`readFrontDeskRequest` selects an exact durable turn ID in that viewer's existing
transcript. It returns the same request ID and conversation ID, an inert reply
when present, and separately projected linked work. It performs no execution,
approval replay, report publication or mutation locking.

The existing transcript, retry window, tombstones, revision digests, diagnostic
outbox and WorkItem identifiers remain authoritative. There is no new job store.

- `replyStatus: answered` means a conversation reply was durably recorded.
- `pending` and `uncertain` do not authorize re-execution.
- `not_started` requires the existing persisted pre-execution rejection receipt.
- `work[].executionStatus: work_completed` requires the existing execution-result
  and artifact readback verification. A conversational “done” is insufficient.
- A live reply with `historySaved: false` may still read back as pending. The
  caller must not blindly retry the execution to repair its history.
- Replaying a reply never restores approval buttons or authority-bearing runtime
  metadata. A status read is not a decision or approval.

The Web adapter retains authentication, mutation authorization, CSRF/rate-limit
checks, scope selection, HTTP validation and response status mapping.
`SurfaceViewerScope` alone is not evidence that those checks took place.

## Authorization-preserving identity

The transcript fingerprint includes principal, member, source, role, tenant,
organization, project and tier restrictions. Matching a principal string is not
enough to share a conversation. Requested scope can only narrow an authenticated
allowed set. A request ID never selects an owner or grants access.

No MCP identity is relabeled as a Web user, token identity or loopback operator.
The diagnostic first-job admission remains public-input-only and explicitly
loopback/localadmin-bound. General conversation entry does not broaden it.

## MCP integration remains a separate authorization step

The current inbound MCP server uses stdio and server-bound identity. It does not
yet expose these Web-owned request operations. A production cross-entry adapter
requires an approved authenticated principal binding; this extraction does not
claim that binding or enable a listener.

The installed MCP SDK is 1.31.0 and advertises protocol 2025-11-25. Adoption of an
OAuth authorization profile is distinct from upgrading protocol lifecycle,
per-request metadata or transport semantics. Do not advertise 2026-07-28 protocol
support without a compatible SDK/implementation and interoperability tests.

For a future remote HTTP adapter, the design target is a distinct OAuth protected
resource with discovery, an audience-bound MCP access token, issuer/signature/
expiry checks, scope enforcement and active membership/resource authorization.
Web sessions and MCP access tokens may map to the same canonical user through
the same identity authority; they are not interchangeable credentials.

Existing browser OIDC login is a relying-party flow: it validates an ID token
for the browser client and creates a local browser session. It is not an OAuth
authorization server and does not issue MCP resource access tokens. Reusing the
browser cookie, ID token or arbitrary Web bearer as MCP authorization is outside
this design. Stdio does not acquire the remote HTTP OAuth flow by implication.

Deployment, provider/client registration, credentials, token storage and any new
HTTP exposure require separately scoped review and authorization.

## Evidence and limits

Focused tests cover exact-turn reads, identity/scope isolation, repeated and
interrupted submission, retry-receipt persistence, and response-save failure.
Ordinary conversation orchestration is not a durable general executor: a crash
after a side effect remains uncertain. Existing MCP background pipeline jobs
are process-local and must not be presented as the durable request backend.

Relevant implementation: `libs/core/surface/front-desk-request-service.ts`,
`front-desk-request-result.ts`, `front-desk-conversation-persistence.ts`,
`front-desk-execution-status.ts`, and Concierge `/api/message`.
