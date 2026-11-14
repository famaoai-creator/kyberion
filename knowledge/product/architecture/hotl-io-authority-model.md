---
title: HOTL / I/O Authority Model — external send & intake approval coverage
category: Architecture
tags: [security, approval, hotl, egress, authority, service-actuator]
importance: 8
last_updated: 2026-11-14
runtime_stages: [alignment, execution]
concepts: [grant, tenant, entity-scope, artifact]
---

# HOTL / I/O Authority Model (MSN-HOTL-IO-AUDIT-20261114)

How external I/O (send & intake) binds to human approval, and where the
delegation/HOTL seams sit. Verdict: the model is **layered and fail-closed**;
the residual risk is declaration coverage, not missing gates.

## The five gates (defense in depth)

| Gate                      | Module                                                           | What it enforces                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Op preflight              | `pipeline/op-preflight.ts` `approvalGuard`                       | Every op call: `requiresApproval` + no granted approval → `[HUMAN_REQUIRED]` (non-interactive) or block                                                                                                                                                                                                                                   |
| Risky-op registry         | `contracts/risky-op-ids.ts` `RISKY_OPS` + `requireApprovalForOp` | Named high-blast-radius verbs gated at call sites: `secret:grant_access`, `auth:grant_authority`, `config:update`, `vault:write`, `claude:browser_interactive`, `claude:document_generation`, `browser:extension_execute`, `desktop:destructive_action`, `ingress:expose` — 8 call sites incl. deployment-actuator, ingress, secret-guard |
| Exact-effect external ops | `governance/external-operation*`                                 | `admitExternalOperation` → `assertExternalOperationCommit` → `recordExternalOperationOutcome`; approval payload hash binds the human decision to the exact effect; reservation prevents replay on retry/crash                                                                                                                             |
| Egress attestation        | `provider/provider-egress-gate.ts` + `reasoning-egress-scope.ts` | LLM egress: `training_use: none` needs a human approval attestation (`llm attest --request-approval`); `assertReasoningEgressAllowedAtEndpoint` guards provider backends                                                                                                                                                                  |
| Separation of duties      | `governance/approval-separation-of-duties.ts`                    | Requester/approver split enforced for approval ops                                                                                                                                                                                                                                                                                        |

## Coverage evidence

- `service-actuator` builds an `ExternalOperation` per external send
  (`service-actuator-helpers.ts:492`): authority + `requiresApproval` +
  admit/commit/occurrence tracking; MCP mode is the only bypass (separate
  boundary, `withExternalOperationAuthority`).
- `network-actuator` wraps every fetch in `runExternalOperation({requiresApproval: !readOnly})` — GET/HEAD pass, writes need approval or a matching charter grant.
- `provider/*-backend.ts` call `assertReasoningEgressAllowedAtEndpoint` before LLM HTTP.
- `peer-messaging` envelopes carry `approval_ref` — inbound peer requests can bind to an approval record; signatures verified on envelopes.

## HOTL delegation model

**Every external operation is charter-delegable where a target can be named.**
A standing grant is an exact-match target inside a signed charter envelope —
the human signs the scope once (HOTL), the runtime emits the identical target
at execution, and anything outside the signed fields still requires per-action
HITL approval. Delegation never widens an effect; it only replaces _who_ made
the admission decision (signed charter vs. per-action prompt).

Three layers must agree for a grant to apply:

1. **Call site** passes `delegable: true` (all external-op call sites do).
2. **Registry** (`foundation/authorization-registry.ts` `delegable` spec)
   declares the grant fields + reputational class — `isDelegableExternalOperation`
   reads only this.
3. **Target builder** (`governance/external-operation-target.ts`
   `EXTERNAL_OPERATION_DELEGATION`) extracts `effect → grant target`; when it
   returns `undefined` the op is not delegable for that effect and falls back
   to approval. A registry↔builder fold test pins the two tables together.

Grants are verbatim exact-match (`parseExternalOperationGrant`) and come in
two widths — the human decides the width at signing time:

- **Bare grant** `{ operation_id }` — delegates the whole operation (HOTL
  default; the human never enumerates destinations). Rendered in the signed
  statement as `target: any` / `ANY <field>`.
- **Scoped grant** `{ operation_id, <fields…> }` — same operation narrowed to
  the named fields; every present key must equal the built target, so a
  scoped grant can only narrow, never widen.

Registry `delegable.fields` declares the _mandatory_ keys a grant must carry;
`optionalFields` are accepted as narrowing constraints. Unknown keys are
rejected, `*` is rejected outside `branch_pattern`, origins normalize
(https-only, no credentials/query/hash), and `requiredOneOf` forces a grant
to name a scope (e.g. a meeting grant must pin a `meeting_id` or
`series_id`). Operations whose scope _is_ the semantic meaning of the
authorization keep mandatory fields — everything else accepts bare grants.

### Delegable surface (grant scope → operation)

| Operation                                                                      | Mandatory scope                                                                  | Optional narrowing                                   | Class |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ----- |
| `vcs:pr_create`                                                                | repository                                                                       | `visibility`                                         | B     |
| `vcs:pr_merge` / `vcs:push`                                                    | repository                                                                       | branch / `branch_pattern`                            | A     |
| `browser:goto` / `browser:open_tab`                                            | —                                                                                | https origin (isolated confinement required)         | B     |
| `service:slack:preset:post_message`                                            | —                                                                                | channel                                              | B     |
| `meeting:join` `listen` `speak` `chat`                                         | platform + meeting_id **or** series_id                                           | —                                                    | B     |
| `voice:playback`                                                               | —                                                                                | platform, format, content_hash (one-artifact grants) | B     |
| `voice:speak`                                                                  | —                                                                                | platform                                             | B     |
| `network:fetch`                                                                | —                                                                                | https origin, method                                 | A     |
| `network:exposure_check`                                                       | —                                                                                | https origin                                         | B     |
| `network:shell`                                                                | —                                                                                | exact command string                                 | A     |
| `network:a2a_send`                                                             | —                                                                                | transport method, recipient peer_id                  | A     |
| `calendar:create_event`                                                        | —                                                                                | backend, calendar_id                                 | A     |
| `calendar:update_event` / `delete_event`                                       | —                                                                                | backend, calendar_id, event_id                       | A     |
| `deployment:deploy_release`                                                    | —                                                                                | adapter, environment, project_name                   | A     |
| `media:generation:{generate_image,generate_video,generate_music,run_workflow}` | —                                                                                | resolved backend_id                                  | A     |
| `tenant:attest_provider`                                                       | full claim tuple (tenant, provider, training_use=none, plan, basis, attested_by) | —                                                    | A     |

Even a bare grant only unlocks the admission layer: tenant binding, data-tier
checks, exact-effect payload hashing, invocation identity, and separation of
duties still apply at execution, and scoped-off effects fall back to HITL.

### Fail-closed boundaries (not delegable)

- **Unscoped effects**: a `network:fetch` to http/credentialed URLs, an
  `a2a_send` envelope with no recipient identity, a `meeting:join` with no
  meeting/series id — `buildTarget` returns `undefined` → per-action approval.
- **Opaque routes**: `service:*` API/HARNESS mode and MCP mode stay
  `delegable: false` at the call site — provider ops become delegable by
  adding a registry spec + a reviewed `buildTarget` entry (see slack preset).
- **Policy-driven risk / charter eligibility**: what counts as risky is
  governed data, not a fixed code list. `approval-policy.json` rules carry an
  optional `charter_eligible`; `resolveApprovalPolicy` derives
  `charterEligible` (default: ineligible when `dual_key_confirmation` is
  required, explicit flag wins). `fallback_rules` in the same file hold the
  danger-pattern regexes for intentIds that match no declared rule — formerly
  hard-coded `HARD_CODED_DANGEROUS_RULES`, still shipped as the built-in when
  a policy lacks the section (fail-closed: an unparseable pattern degrades to
  "always match" → approval required). `RISKY_OPS` in
  `contracts/risky-op-ids.ts` remains the stable _identifier vocabulary_
  callers use at gated call sites; the determination lives in the policy.
  Non-overridable floors: `mandatoryApproval`, `injection-suspected-override`,
  `strict-posture-floor` (runtime posture facts, never delegable) — and a
  charter grant still satisfies only the admission layer, not the independent
  risky-op gate.
- **Browser without confinement**: `browser:*` delegates only under
  `isolated-public-read-v1` navigation confinement.

- **Standing grants** (`runtime/grants`, PG-03): durable delegation; expired/revoked records kept as evidence; never auto-deleted.
- **Per-action approval**: `approval-store` + `pipeline-approval-resume` +
  `approval:request`/`approval:request_review` ops; `--request-approval` +
  `pnpm kyberion approvals --approve <id>` for approval-mediated verbs.
- **Approval domains**: `foundation/approval-domains.ts` taxonomy; veto window
  (`approval-veto-window`), revocation (`approval-revocation`), passkey
  challenge (`approval-passkey-challenge`), human proof (`approval-human-proof`).

## Residual gaps (to close or accept explicitly)

1. **`approval_required` is author-declared**: `adf-engine` sets
   `requiresApproval` from `step.budget.approval_required` /
   `_approval_required` — a pipeline author can omit it. Mitigation depends on
   the op's own external-operation guard (service/network actuators self-gate),
   but an op type that performs external effects without self-gating relies on
   author discipline. Recommend: a manifest-level `external: true` flag that
   forces `requiresApproval` regardless of step budget.
2. **MCP bypass**: `service-actuator` skips admit/commit for `mode === 'MCP'`
   — relies on MCP surface authn/authorization elsewhere; document that MCP
   tools carry their own governed boundary or tighten.
3. **`fetch()` call sites in libs/core** (14 files): provider backends are
   egress-gated, but `control-plane-client`, `presence-bridge`, `speech-cpp`,
   `audit-forwarder`, `surface-runtime` use raw fetch — these are infra/loopback
   surfaces; verify none perform unreviewed external sends (they are documented
   localhost/loopback defaults).
4. **Inbound verification depth**: peer envelopes sign + `approval_ref`, but
   inbound→effect chains (peer task execution) should be traced once for
   principal binding before mutation.
