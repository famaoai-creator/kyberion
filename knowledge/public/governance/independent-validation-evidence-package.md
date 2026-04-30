---
title: Independent Validation Evidence Package
category: Governance
tags: [validation, sr-11-7, audit, model-risk, regulated-finance, evidence]
importance: 8
last_updated: 2026-04-27
---

# Independent Validation Evidence Package

When Kyberion outputs are used to inform decisions in **regulated finance**
contexts (banking, securities, insurance, payments) where third-party
model-risk validation is expected (e.g. SR 11-7, OSFI E-23, ECB TRIM,
J-SOX equivalents), the operator must hand the validator a **complete,
self-describing evidence bundle**.

This document defines what that bundle contains, where each artefact lives,
and what attestations the operator must provide. It is the "what to give
the validator" reference; the validator's process itself is outside the
Kyberion architecture.

## 1. When is this package required?

Required for any output that:

- Is presented as **decision evidence** (not merely "decision input") in
  a regulated decision, or
- Carries a `simulation-quality.json` of severity `ok` but is used in a
  context where independent validation is mandated by policy, or
- Was generated for a tenant whose
  `tenant-scope-policy.json` declares `external_validation_required: true`
  for the relevant decision class.

It is **not** required for exploratory analysis, internal scenario
brainstorming, or any output whose disclosure already says "advisory only".

## 2. Bundle contents

The bundle is a single archive. It must include each of the following.
Missing items mean the bundle is incomplete and must not be handed to
the validator.

### 2.1 The output under review

| Artefact | Location |
|---|---|
| `simulation-summary.json` | mission `evidence/` |
| `simulation-quality.json` | mission `evidence/` |
| `simulation-ensemble.json` (if multi-run) | mission `evidence/` |
| `hypothesis-tree.json` (if applicable) | mission `evidence/` |
| `dissent-log.json` | mission `evidence/` |
| Final Markdown report | mission `evidence/` |

### 2.2 The reasoning context

| Artefact | Source |
|---|---|
| Full prompt(s) sent to the reasoning backend | mission `evidence/prompts/` (export from `audit-chain`) |
| Full system prompt(s) | same |
| All persona definitions used in the run | snapshot from `team-role-index.json` at run time |
| `intent-snapshot` chain for the mission | `intent-snapshot-store` |
| Mission state at each checkpoint | mission's independent Git history |

### 2.3 The reasoning environment

| Artefact | Source |
|---|---|
| Reasoning backend mode and model id | `reasoning-bootstrap` log; `claude-opus-4-7` etc. |
| Backend version (SDK / CLI) | `package.json` + `pnpm-lock.yaml` snapshot |
| Effort / thinking parameters | run config |
| Ensemble run count and convergence threshold | `simulation-ensemble.json` |
| Reasoning rate-limits / quotas at run time | provider account snapshot if available |

### 2.4 The audit story

| Artefact | Source |
|---|---|
| Full hash-chained audit-chain excerpt covering this mission | `active/audit/system-ledger.jsonl` filtered by mission_id |
| All `rubric.override_accepted` events | same, filtered by action |
| All re-execution events (`counterfactual.rerun_*`) | same |
| Tenant scope events (`tenant.scope_violation` if any) | same |
| Hash-chain integrity proof (parent_hash continuity) | computable from the excerpt |

### 2.5 Governance artefacts

| Artefact | Reference |
|---|---|
| `counterfactual-degradation-policy.json` (version at run time) | `knowledge/public/governance/` |
| `mission-classification-policy.json` (version at run time) | `knowledge/public/governance/` |
| `tier-hygiene-policy.json` (version at run time) | `knowledge/public/governance/` |
| `tenant-scope-policy.json` (when multi-tenant) | tenant config |
| `rubric-disclosure-template.md` filled in for this output | `knowledge/public/procedures/system/` |

### 2.6 Operator attestations (signed)

Each of the following must be signed by the named role. Signatures live
in `bundle/attestations/` as `*.signed.json` files, each carrying the
operator's identity, the mission_id, and a short statement.

| Attestation | Signer |
|---|---|
| "All artefacts in §2.1–§2.5 are unmodified copies of the production run." | mission_owner |
| "No `audit-chain` entries pertaining to this mission have been redacted from the bundle." | knowledge_steward |
| "All `rubric.override_accepted` events are accompanied by their original reason text and are unaltered." | tenant_risk_officer (or equivalent) |
| "The reasoning backend identified in §2.3 is the one that produced the output, and no post-hoc backend swap occurred." | ecosystem_architect |

## 3. What the validator should be able to do with the bundle

The bundle is sufficient when an external validator can, **without
additional access to Kyberion**:

1. Reconstruct the prompts and verify they match what audit-chain
   recorded.
2. Verify the audit-chain hash-chain continuity end-to-end.
3. Check that every claim in the final report is supported by an
   artefact in the bundle.
4. Re-run the rubric (deterministic) on the included
   `simulation-summary.json` and reproduce the `simulation-quality.json`.
5. (Where applicable) re-run the LLM portion themselves with the same
   prompt and compare distributions, knowing the result will not be
   bit-identical due to non-determinism.

If any of (1)–(4) cannot be done from the bundle alone, the bundle is
incomplete.

## 4. What this package does **not** provide

- It does **not** make the LLM output deterministic. Validators must
  treat (5) above as a distribution comparison, not a re-execution.
- It does **not** substitute for the validator's own judgement. The
  rubric is an internal check; SR 11-7-style independent validation is
  a separate, external process.
- It does **not** include LLM internals (KV cache, attention patterns).
  These are not produced by current Kyberion-supported backends.

## 5. Practical export procedure

```bash
# planned — not yet implemented as a single command
mission_controller export-validation-bundle <MSN-ID> \
  --output bundle.tar.gz \
  --include-knowledge-snapshot \
  --include-attestations
```

Until the dedicated command exists, assemble the bundle by hand following
§2 and verify completeness against §3 before delivery.

## 6. Related

- [`counterfactual-degradation-policy.json`](knowledge/public/governance/counterfactual-degradation-policy.json)
- [`../procedures/system/rubric-disclosure-template.md`](knowledge/public/procedures/system/rubric-disclosure-template.md)
- [`../architecture/multi-tenant-operations.md`](knowledge/public/architecture/multi-tenant-operations.md)
- [`../architecture/operator-surface-strategy.md`](knowledge/public/architecture/operator-surface-strategy.md)
