---
record_id: mem-MSN-PEER-LLM-RESPONDER-20261018-2026_10_18
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PEER-LLM-RESPONDER-20261018-2026_10_18
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-18T11:16:38.158Z
source_branch: feat/peer-llm-responder-20261018
source_commit: 5d35614eb8985daa0a35eb4b9941646703d3046f
---

# Untrusted peer text to an LLM: isolate the generator, bind tenant roles, dedup by stable ids

Lessons from adding opt-in LLM auto replies between Kyberion peers: the reasoning failover chain and default Agent SDK options are not safe for untrusted input, tenant-parameterised reader roles must not trust a caller-supplied tenant, and retried deliveries need stable message ids.

## Applicability

- mission
- mission:MSN-PEER-LLM-RESPONDER-20261018

## Reusable Steps

1. Lessons from adding opt-in LLM auto replies between Kyberion peers: the reasoning failover chain and default Agent SDK options are not safe for untrusted input, tenant-parameterised reader roles must not trust a caller-supplied tenant, and retried deliveries need stable message ids

## Expected Outcome

- Never send untrusted text through getReasoningBackend(): its failover chain reaches CLIs that run with tools (claude-cli with project settings, codex workspace-write). Use a registered IsolatedTextGenerator (libs/core/provider/isolated-text-generator.ts) whose descriptor declares isolated_text_generation.
- The Claude Agent SDK loads user/project settings, hooks, CLAUDE.md and MCP when settingSources is omitted, even with tools: []. Pass isolation: 'strict' to runClaudeAgentQuery (settingSources [], no MCP/hooks/plugins, scratch cwd, env without KYBERION__/MISSION__); under strict, extraOptions is an allowlist.
- codex-cli (0.163) cannot hide tools from the model even with every tool feature disabled; tool attempts surface only as stderr tools::router errors, not as JSON items. Treat Codex as fail_closed_detection: discard the output on any attempt and gate on tested CLI versions; re-probe on upgrade.
- A role whose grants use ${KYBERION_TENANT} must reject binding to a tenant other than the caller's active tenant (TENANT_BOUND_READER_ROLES); a caller-supplied tenant never broadens access. Use deny_read to carve secrets (connections/) out of a broad tenant read grant.
- Tenant egress overlays and attestations are read under the caller's role: run tenant-bound generation inside the tenant-bound responder role, or the gate fails with ROLE_VIOLATION on the overlay.
- Reasoning zero_retention sends must decide through the same evaluator as checkProviderEgress (attestation + tenant allowed_reasoning_backends + provider declaration) so the two gates cannot drift.
- Retried peer deliveries must reuse one message id per job so the receiver deduplicates; keep the LLM out of the HTTP receive path (enqueue, ACK as status, generate in a worker) and bound agent-to-agent loops by a per-session cap counted from the job ledger plus a per-peer rolling budget.

## Evidence

- active/missions/public/MSN-PEER-LLM-RESPONDER-20261018/evidence/distillation.md

## Artifacts
