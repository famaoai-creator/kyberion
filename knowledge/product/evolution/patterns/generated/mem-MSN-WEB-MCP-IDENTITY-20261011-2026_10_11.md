---
record_id: mem-MSN-WEB-MCP-IDENTITY-20261011-2026_10_11
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ""
candidate_id: mem-MSN-WEB-MCP-IDENTITY-20261011-2026_10_11
supersedes: ""
superseded_by: ""
project_id: ""
task_session_id: ""
specialist_id: ""
locale: ""
created_at: 2026-10-11T00:51:51.193Z
source_branch: feat/web-mcp-identity-20261011
source_commit: c131621628c0e6b625018d56d81847585c24a561
---

# Bind browser identity proof to the verified principal and make HTTP activation explicit

Cross-entry request identity must originate at cryptographic verification, intersect current authority, and remain separate from deployment activation.

## Applicability

- mission
- mission:MSN-WEB-MCP-IDENTITY-20261011

## Reusable Steps

1. Cross-entry request identity must originate at cryptographic verification, intersect current authority, and remain separate from deployment activation

## Expected Outcome

A browser principal may omit the external subject even after a signed session was verified. Bridge canonical request identity at that verification boundary using immutable server-internal proof tied to the exact principal object; serialized claims, copied objects, email and login scopes are not substitutes. Revalidate expiry and strict active-member external bindings on each request, intersect final viewer restrictions, require the selected tenant operation grant, and audit before request reservation or history access. Never fall back to legacy identity after selecting a canonical path that fails verification. Preserve explicit bearer-header precedence and cookie CSRF. Test authenticated browser and HTTP entries with the same effective authority and request ID, including pending, completed and uncertain outcomes, revocation, duplicate bindings and audit failures.

Runtime composition is incomplete until a registered callable entrypoint exists. Keep configuration default-off and strict, mount resource metadata at the correct root, make check mode listener-free, and require explicit start and deployment settings. Loopback reverse-proxy support cannot attest external TLS or a real authorization provider. Record those limits separately from synthetic protocol tests. Run the exact module-boundary suite as well as aggregate gates: an aggregate count alone does not establish dependency-direction correctness. A missing pinned browser is an unresolved environment-dependent gate, not permission to suppress a check or claim live integration.

## Evidence

- active/missions/public/MSN-WEB-MCP-IDENTITY-20261011/evidence/implementation-report.md
- active/missions/public/MSN-WEB-MCP-IDENTITY-20261011/evidence/test-report.md
- active/missions/public/MSN-WEB-MCP-IDENTITY-20261011/evidence/REVIEW-execution-implement.md

## Artifacts
