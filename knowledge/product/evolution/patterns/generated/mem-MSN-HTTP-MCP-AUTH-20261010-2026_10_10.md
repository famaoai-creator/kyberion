---
record_id: mem-MSN-HTTP-MCP-AUTH-20261010-2026_10_10
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-HTTP-MCP-AUTH-20261010-2026_10_10
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-10T17:13:07.958Z
source_branch: feat/http-mcp-resource-server-20261010
source_commit: bccc2ebd1b76bac857b148bba3962e43693740e5
---

# Keep verified human ownership separate from MCP transport authority

A default-disabled MCP resource server can share human request ownership only through verified registry bindings and restriction-preserving canonical identity, with operation authorization checked independently on every request.

## Applicability

- mission
- mission:MSN-HTTP-MCP-AUTH-20261010

## Reusable Steps

1. A default-disabled MCP resource server can share human request ownership only through verified registry bindings and restriction-preserving canonical identity, with operation authorization checked independently on every request

## Expected Outcome

Apply when adding an authenticated remote request adapter or an opt-in verified browser identity seam. Verify the resource-specific access-token profile before resolving exact issuer and subject through the full governed member registry; reject ambiguous, suspended or unmapped bindings. Never trust token member or role claims as local membership. Intersect selected-tenant membership, operation scopes, server policy and request narrowing. A versioned canonical human owner may converge explicitly registered aliases, but its fingerprint must retain all effective data restrictions and active membership changes. Keep transport provenance in audit evidence, leave legacy history namespaces unchanged, and do not widen diagnostic/local administration. Expose only the approved shared request operations. Validate scopes before handlers, and retain synchronous request reservations, inert replay and uncertain-state no-retry behavior. Exercise actual ownership and request lifecycle logic using independently resolved Web/MCP synthetic viewers; disclose mocked storage/lock seams and absent live provider/browser coverage. Default-disabled source verification is a bounded milestone: passing synthetic tests and PR gates does not establish production OAuth interoperability or a passing browser suite.

## Evidence

- active/missions/public/MSN-HTTP-MCP-AUTH-20261010/evidence/design-spec.json
- active/missions/public/MSN-HTTP-MCP-AUTH-20261010/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-HTTP-MCP-AUTH-20261010/evidence/test-report.md

## Artifacts
