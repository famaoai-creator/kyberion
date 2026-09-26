---
title: Running and Probing Tenant-Bound Pipelines Without Policy Violations
category: Governance
tags: [governance, tenant, persona, authority, chronos, kill-switch, probing, tier-guard]
importance: 7
last_updated: 2026-09-24
role_affinity: [mission_controller, ecosystem_architect, operator]
phase_affinity: [execution, review]
---

# Running and Probing Tenant-Bound Pipelines Without Policy Violations

**Purpose**: the identity/env combinations that make tenant-scoped work
(pipelines under `knowledge/confidential/{tenant}/pipelines/`, tenant
knowledge writes, chronos tenant runs) trip the tier guard, and the setup
that does not. Every denial counts toward the kill switch, so "try another
persona" is not a free debugging strategy.
Model background: [AUTHORITY_MODEL](./AUTHORITY_MODEL.md) (evaluation order,
§4) and [multi-tenant-operations](../architecture/multi-tenant-operations.md).

## 1. Combinations that trigger violations — and why

| Symptom (denial text)                                                                                                                                 | Env / identity that causes it                                                                                             | Why                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Organization Confidential: Higher tier required` on a read of `knowledge/confidential/...`                                                           | No `MISSION_ROLE`, or a role/persona whose grants do not cover the path (`worker`, `analyst`, `unknown`)                  | Confidential reads need an authority, role or persona grant (`tier-guard.ts` `validateReadPermission`). Listing `knowledge/confidential/` itself is a confidential read — even an `lstat` walk through secure-io.                                     |
| Same text on **write**, although `MISSION_ROLE` looks right                                                                                           | `withExecutionContext(role)` replaced your persona with the role's default persona (e.g. `knowledge_steward` → `analyst`) | `enterExecutionEnv` in `authority.ts` sets `KYBERION_PERSONA` from the role; the persona-intrinsic `KNOWLEDGE_WRITE` authority exists only for `sovereign` / `ecosystem_architect`. A role without its own `allow_write` for the path is then denied. |
| `Persona 'worker' with authority role '<role>' is NOT authorized to write to 'customer/{tenant}/logs/audit/...'` (audit-chain "Tenant mirror failed") | A tenant-bound process (`KYBERION_TENANT` set) whose role has no grant for the tenant audit/trace mirror                  | `audit-chain.ts` mirrors every record into `customer/{tenant}/logs/audit/`. Grant it with the `${KYBERION_TENANT}` placeholder (`customer/${KYBERION_TENANT}/logs/audit/`), never a literal slug.                                                     |
| `tenant.scope_violation` / `tenant.scope_missing`                                                                                                     | `KYBERION_TENANT=a` touching `knowledge/confidential/b/`, or `KYBERION_TENANT_SCOPE_REQUIRED=1` with no binding           | `checkTenantScope` (deny-unless-brokered). Correct behaviour — fix the caller, not the binding.                                                                                                                                                       |
| `Ring 3 agents are restricted to read-only operations`                                                                                                | `KYBERION_AGENT_RING=3` (sandboxed child) attempting a write/exec                                                         | `agent-policies.yaml` `ring-3` rule.                                                                                                                                                                                                                  |
| Spurious `Higher tier required` from a probe that works as a pipeline                                                                                 | The probe imports `libs/core/*.ts` **source** while the code under test imports `@agent/core/*` **dist**                  | Two module registries → two secure-io/authority singletons; the execution context set in one is invisible to the other ([development practices §4](./kyberion-development-practices.md)).                                                             |
| `TIBA_VIOLATION: No active temporal grant or authorized scope for service "x"`                                                                        | Credential read without `AUTHORIZED_SCOPE=x` or a mission grant                                                           | `secret-guard.ts` `getSecret`. Tenant pipelines declare it in their ADF `runtime` block (see §2), never daemon-wide.                                                                                                                                  |

## 2. Correct environment for tenant-bound runs

A tenant pipeline runs exactly as chronos runs it: in its own process with

```
KYBERION_TENANT=<tenant>              # binds every tenant-scoped grant (${KYBERION_TENANT})
KYBERION_TENANT_SCOPE_REQUIRED=1      # protected paths without a binding are denied
MISSION_ROLE=chronos_tenant_runner    # reads: tenant registry + knowledge/confidential/${KYBERION_TENANT}/
KYBERION_PERSONA=worker               # no persona-intrinsic authorities
KYBERION_SUDO=                        # never inherited
# plus ONLY what the ADF `runtime` block declares, resolved by chronos:
AUTHORIZED_SCOPE=<service>                     # runtime.authorized_scope (one service)
KYBERION_REASONING_BACKEND=<mode>              # runtime.reasoning_backend
KYBERION_TENANT_EGRESS_POLICY_PATH=<json>      # runtime.egress_policy_ref (tenant egress overlay)
```

`resolveTenantRuntimeEnv` / `buildTenantRunEnv` in `scripts/chronos_daemon.ts`
compute this. Every declared value must be inside the tenant's
`{knowledge_root}/governance/pipeline-runtime-allowlist.json` (absent file =
nothing may be requested) and the global ceiling (registered service ids,
governed reasoning modes, the tenant's own root). The daemon's own env is
never forwarded. Because the project-trust approval hashes the whole ADF, the
declared `runtime` needs are part of what the human approved; editing them
invalidates the approval.

Knowledge landings inside that process go through `ingest:commit`, which
switches to the narrow `ingest_commit` role for the write itself.

Interactive, non-tenant-bound CLI work that writes confidential knowledge
still needs a persona with a write grant (e.g.
`KYBERION_PERSONA=ecosystem_architect`, `MISSION_ROLE=mission_controller` for
tenant-registry reads) — see [AUTHORITY_MODEL §6](./AUTHORITY_MODEL.md).

## 3. Probing safely

1. **Read the grant before you run.** Check `security-policy.json`
   `authority_role_permissions.<role>` and `persona_permissions.<persona>` for
   the exact path. One denial is information; a second with a guessed
   persona is noise that counts toward the kill switch.
2. **Probe with the real entry point in the real shape**: the tenant-bound
   env above, `dist/` builds (`pnpm --filter @agent/core build && pnpm run
build:actuators`), and `@agent/core/*` imports in any throwaway probe
   script — never mixed with `libs/core/*.ts` source.
3. **Dry-run first.** Pipelines: `pnpm pipeline --input <adf> --dry-run`
   (validation only) or a pipeline-level dry-run flag in `context` (e.g.
   `{"meeting_digest_dry_run": true}`); ops that write knowledge should accept
   `dry_run` and report planned actions without writing.
4. **Order**: registry/tenant resolution → reads → dry run → one real write.
   Stop at the first denial and fix the grant or the caller.
5. **Unit-level checks** run hermetically: fixture roots under a uniquely
   named `pathResolver.sharedTmp()` subdirectory are default-allowed, so they
   prove logic, not grants — the real-root probe in (2) is still required.

## 4. Kill switch: what is counted, and how to check it

- Every secure-io denial calls `recordGovernanceAction(..., policyViolation=true)`
  (`governance-action-recorder.ts`), which feeds `killSwitch.logAction`
  (`kill-switch.ts`). The counters are **in memory, per process**: a
  short-lived probe process cannot accumulate violations across runs.
- The monitor (`killSwitch.startMonitor`) runs only in long-lived or pipeline
  processes. Threshold: `trust-policy.json`
  `anomaly_detection.policy_violations` (default 3 in 10 min). A trip warns,
  isolates (Ring 3) or requests a kill approval, and lowers the agent's
  persisted trust score.
- Persisted state to inspect: the trust ledger
  `knowledge/personal/governance/agent-trust-scores.json` (per-agent score
  history; recovers by decay per `trust-policy.json`), and
  `active/shared/logs/audit/audit-YYYY-MM-DD.jsonl` (`policy_violation`,
  `anomaly_detected`, `tenant.scope_violation` records).
- "Reset": in-memory counters end with the process. A lowered persisted
  trust score is an operator decision to correct — edit the personal-tier
  ledger deliberately, never from an agent loop.

## 5. Code pointers

- Tier/role/persona evaluation: `libs/core/tier-guard.ts`
  (`validateReadPermission`, `validateWritePermission`, `checkTenantScope`,
  `${KYBERION_TENANT}` placeholder in `expandPolicyPath`).
- Identity resolution and role → persona defaults: `libs/core/authority.ts`
  (`withExecutionContext`, `enterExecutionEnv`, `resolveIdentityContext`).
- Write-side policy engine: `libs/core/secure-io.ts` +
  `knowledge/product/governance/agent-policies.yaml`.
- Tenant runner: `scripts/chronos_daemon.ts`; role
  `knowledge/product/governance/authority-roles/chronos_tenant_runner.json`.
- Tenant egress overlay: `libs/core/egress-policy.ts`
  (`KYBERION_TENANT_EGRESS_POLICY_PATH`).
- Kill switch / trust: `libs/core/kill-switch.ts`, `libs/core/trust-engine.ts`.
