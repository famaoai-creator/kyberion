# Pipelines

## Directory Layout

```
pipelines/
  *.json          ← Kyberion system operation pipelines (self-ops only)
  *.yml           ← Legacy YAML skill-chain files (system scope)
  fragments/      ← Reusable step groups (core:include targets)

knowledge/product/pipeline-templates/
                  ← Canonical user-facing pipeline patterns (parameterized, no personal data)
                    Tenants instantiate these into their own namespace before running.
                    See `knowledge/product/pipeline-templates/README.md` for the preflight requirement.
```

**Scope rule:**

- `pipelines/` contains only pipelines that operate Kyberion itself — health checks, self-repair, onboarding, capability assimilation, chaos tests.
- User-facing workflows (voice, meeting, sales, content, etc.) live as **templates** in `knowledge/product/pipeline-templates/`.
- Tenant-specific instantiations go in `knowledge/confidential/{tenant}/pipelines/` or `knowledge/personal/pipelines/`.

**Running a system pipeline:**

```bash
node dist/scripts/run_pipeline.js --input pipelines/<name>.json
# or shortcut:
pnpm pipeline --input pipelines/<name>.json
```

**Running a template directly (dev/testing only):**

```bash
node dist/scripts/run_pipeline.js --input knowledge/product/pipeline-templates/<name>.json
```

---

## What logic belongs in a pipeline

Pipelines are declarative wiring plus a governance envelope (trace, replay, budgets, guardrails). Keep logic in the layer that owns it (→ [LAYERED_EXECUTION_PLAN](../docs/developer/improvement-plans-2026-07/LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)):

| Belongs in the pipeline                                  | Belongs in a typed actuator op (TypeScript)                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Sequential step wiring, `produces`/`consumes` channels   | State-driven loops (repeat until a computed condition, accumulate-and-decide) |
| Data-driven `core:foreach` over a known list             | Computation, data shaping, sorting/dedup                                      |
| Scenario-level `core:if` (e.g. include a login fragment) | Result verification ("did the actuator really succeed?")                      |
| Approval gates, budgets, `on_error` strategy             | Waiting/retry semantics (auto-wait belongs to the op, like browser ops)       |
| Semantic briefs handed to `reasoning:*`/`wisdom:*`       | Anything you are tempted to write inside `core:transform` `script`            |

Rules of thumb:

- `core:transform` is for small glue only. Scripts longer than the governance limit (default 400 chars) trigger the `transform-script-oversized` guardrail warning — move that logic into a typed op with an input/output contract.
- Do not wrap a script with a `system:exec` step just to give it a pipeline name. Expose the script's logic as an actuator op so trace spans, budgets, and error classification reach inside it.
- For visual artifacts (PPTX/doc/video), author semantic content and set `designDefaults` / theme on the protocol — never inline per-element style literals.

## System Pipelines

### Health & Diagnostics

| Pipeline                      | pnpm shortcut                                         | Description                                                   |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `baseline-check`              | `pnpm pipeline --input pipelines/baseline-check.json` | Session-start health gate (onboarding / recovery / all-clear) |
| `vital-check`                 | `pnpm vital`                                          | Core liveness check                                           |
| `system-diagnostics`          | `pnpm diagnose`                                       | Detailed system-level diagnostic report                       |
| `full-health-report`          | —                                                     | Aggregated health across all surfaces                         |
| `monitor-service-health`      | —                                                     | Continuous service health monitor                             |
| `system-upgrade-check`        | `pnpm system:upgrade:check`                           | Detect available system + dependency upgrades                 |
| `system-upgrade-execute`      | `pnpm system:upgrade:execute`                         | Apply upgrades interactively                                  |
| `inspect-system-hardware`     | —                                                     | Hardware and resource inventory                               |
| `inspect-network-environment` | —                                                     | Network topology and connectivity check                       |
| `inspect-workspace-surfaces`  | —                                                     | Active surface and channel inventory                          |
| `agent-provider-check`        | —                                                     | Verify AI provider availability                               |

### Feedback Loop (Self-Repair)

| Pipeline                        | Description                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `reconcile-config-fallbacks`    | Auto-repair missing knowledge JSON files recorded during config loader fallbacks |
| `reconcile-unclassified-errors` | Write rule-proposal stubs for errors that matched no classification rule         |
| `reconcile-unhandled-intents`   | Write routing proposals for unrouted or unrecognized surface intents             |

### Onboarding & Provisioning

| Pipeline                         | pnpm shortcut  | Description                                                 |
| -------------------------------- | -------------- | ----------------------------------------------------------- |
| `kyberion-autonomous-onboarding` | `pnpm onboard` | Full autonomous onboarding (install → surfaces → alignment) |
| `kyberion-config-provisioner`    | —              | Provision operator config from canonical defaults           |
| `launch-first-run-onboarding`    | —              | Interactive first-run setup wizard                          |
| `platform-onboarding`            | —              | Platform-level dependency bootstrap                         |

### Capability & Knowledge

| Pipeline                             | pnpm shortcut         | Description                                             |
| ------------------------------------ | --------------------- | ------------------------------------------------------- |
| `knowledge-sync`                     | `pnpm knowledge:sync` | Sync knowledge artifacts to public tier                 |
| `list-capabilities`                  | —                     | Enumerate installed actuators and their ops             |
| `assimilate-gateway-capability`      | —                     | Ingest an external gateway into the capability registry |
| `assimilate-gateway-capability-test` | —                     | Smoke test for gateway assimilation                     |
| `assimilate-harness-capability`      | —                     | Ingest a harness-style capability bundle                |
| `license-injection-inner`            | —                     | Inner stage of license key injection                    |
| `license-injection-outer`            | —                     | Outer stage of license key injection                    |

### Verification

| Pipeline                  | Description                               |
| ------------------------- | ----------------------------------------- |
| `verify-discovery-ops`    | Verify provider discovery and op registry |
| `verify-session`          | Verify surface session lifecycle          |
| `verify-session-fallback` | Verify session fallback behaviour         |
| `service-lifecycle-smoke` | Service start/stop/health smoke test      |
| `orchestration-jobs`      | Run scheduled orchestration batch         |

### Chaos & Resilience

| Pipeline                  | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `chaos-actuator-down`     | Simulate actuator failure; validate fallback               |
| `chaos-network-partition` | Simulate network partition; validate retry/circuit-breaker |
| `chaos-repair-test`       | Validate self-repair after injected fault                  |
| `chaos-secret-missing`    | Simulate missing secret; validate secret-guard error path  |

---

### Promoted (pipeline:promote)

Pipelines promoted from successful one-off runs (LC-02). Provenance is recorded in each file under `promotion`.

| Pipeline | pnpm shortcut | Description |
| -------- | ------------- | ----------- |

## Fragments (`pipelines/fragments/`)

Step-group building blocks consumed via `core:include`. Fragments contain no personal data and are safe to compose into any pipeline or template.

```json
{ "op": "core:include", "params": { "path": "pipelines/fragments/common/log-lifecycle.json" } }
```

See `pipelines/fragments/` for the full catalog.

---

## Pipeline Templates (`knowledge/product/pipeline-templates/`)

Canonical user-facing pipeline patterns. These are parameterized (use `{{params.*}}` placeholders) and contain no hardcoded personal data.

**Instantiate a template for your tenant:**

1. Copy the template to `knowledge/confidential/{tenant}/pipelines/{name}.json`
2. Fill in tenant-specific params (endpoints, persona, credentials via `secret:`)
3. Run from the tenant path

Templates cover: voice setup, meeting facilitation, sales workflows, content generation, code review, deployment, analysis, and more. See `knowledge/product/pipeline-templates/` for the full list.

For cross-tool office work, use `productivity-task-orchestration.json` after creating a plan with `pnpm cli -- task plan`. The template is dry-run only: it creates a review package and receipt but performs no calendar write, meeting participation, email send, browser action, payment, or network request.

---

## Op Syntax Reference

Every step `op` uses **`domain:action`** format:

```json
{ "op": "media:pptx_render" }       // media-actuator
{ "op": "wisdom:knowledge_search" } // wisdom-actuator
{ "op": "system:shell" }            // built-in runner
{ "op": "core:if" }                 // built-in control flow
{ "op": "reasoning:analyze" }       // reasoning backend
```

### Pipeline ID Resolution

In `intent-routing-map.json`:

- **Bare ID** (e.g. `"baseline-check"`) → runner prepends `pipelines/`
- **Path ID** (e.g. `"knowledge/product/pipeline-templates/speak-with-my-voice"`) → runner appends `.json` and uses the path as-is

### service-actuator: preset calls

```json
{
  "op": "service:preset",
  "params": {
    "service_id": "backlog",
    "operation": "get_issues",
    "auth": "secret-guard",
    "params": { "space": "your-space", "query": { "projectId[]": [12345], "count": 50 } }
  }
}
```

---

## Path Security

Output paths must be within the project root. Use `active/shared/tmp/` or `active/shared/exports/` as staging areas.

`[ROLE_VIOLATION]` errors mean the active persona/role does not have access to the requested path. Check `knowledge/product/governance/security-policy.json`.

---

## Path Conventions — write portable, machine-independent paths

**Default: write paths as repo-relative.** A relative path like `active/shared/tmp/run.json` or `knowledge/product/x.md` is already portable across machines — it is resolved against the project root at runtime (actuator ops relativize against root, and `system:exec` / `system:shell` run with `cwd` = project root). You almost never need an absolute path in a pipeline.

**Never do:**

- **Machine-absolute paths** — `/Users/<name>/...`, `/home/<user>/...`, `C:\Users\...`. These break the moment the pipeline runs on another machine. The governance lint (`pnpm check:governance-rules`) fails the build on these in committed `knowledge/`, `libs/`, `scripts/`.
- **Leading-slash "repo" paths** — `/knowledge/personal/x.md` is an _absolute_ path pointing at the filesystem root (`/knowledge/...`), **not** the repo. Drop the leading slash: `knowledge/personal/x.md`. (This was a real bug fixed in `system-upgrade-check.json`.)

**When you genuinely need an absolute path at runtime** (e.g. a value handed to an external tool that does not inherit `cwd` = root), resolve it at runtime instead of hardcoding it — keep the source portable:

- **Inline path tokens** in any `{{...}}`-templated field: `{{@root}}`, `{{@knowledge:product/x.md}}`, `{{@shared:tmp/run.json}}`, `{{@active:missions}}`, `{{@tmp:run.json}}`, `{{@vault:...}}`. Each expands to a machine-local absolute path at run time. Unknown domains are left literal.
- **`system:resolve_path` op** (pure, no I/O) — `mode`: `resolve` | `shared` | `knowledge` | `active` | `tmp` | `vault` to expand, and `to_relative` | `normalize` to collapse back.

**Never persist a resolved absolute path.** Tokens / `resolve_path` expand to a machine-local absolute path — fine for transient use this run, but if you write it into a context file, registry, or artifact you have re-introduced a machine-specific path. Before storing a path, collapse it with `system:resolve_path` (`mode: to_relative` or `normalize`) — or `pathResolver.toRepoRelative()` in code — so what lands on disk stays repo-relative.

`KYBERION_ROOT` overrides project-root detection when a pipeline runs from a non-standard working directory.
