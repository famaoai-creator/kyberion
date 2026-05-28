# Pipelines

実運用または共通オーケストレーション向けの JSON ADF pipeline を配置するディレクトリです。Execute via the built pipeline runner:

```bash
node dist/scripts/run_pipeline.js --input pipelines/<name>.json
```

Actuator 固有のサンプルや検証用 pipeline はここに置かず、各 actuator 配下の `examples/` へ配置します。

- Browser-Actuator examples: `libs/actuators/browser-actuator/examples/`

## Available Pipelines

> Only pipelines with a corresponding `.json` file in this directory are listed. Run `ls pipelines/*.json` to see all files.

### Health & Diagnostics

| Pipeline | pnpm shortcut | Description |
|---|---|---|
| `baseline-check` | `pnpm pipeline --input pipelines/baseline-check.json` | Session-start health gate (onboarding / recovery / all-clear) |
| `vital-check` | `pnpm vital` | Core liveness check |
| `system-diagnostics` | `pnpm diagnose` | Detailed system-level diagnostic report |
| `full-health-report` | — | Aggregated health across all surfaces |
| `system-upgrade-check` | `pnpm system:upgrade:check` | Detect available system + dependency upgrades |
| `system-upgrade-execute` | `pnpm system:upgrade:execute` | Apply upgrades interactively |

### Knowledge & Governance

| Pipeline | pnpm shortcut | Description |
|---|---|---|
| `knowledge-sync` | `pnpm knowledge:sync` | Sync knowledge artifacts to public tier |
| `orchestration-jobs` | `pnpm orchestration:jobs` | Run scheduled orchestration batch |
| `analysis-job` | `pnpm analysis:job` | Generic analysis task runner |
| `judgment-job` | `pnpm judgment:job` | Governance judgment evaluation |
| `kyberion-autonomous-onboarding` | `pnpm onboard` | Full autonomous onboarding (install → surfaces → alignment) |
| `kyberion-config-provisioner` | — | Provision operator config from canonical defaults |
| `intent-audit-api-gdpr` | — | GDPR intent audit over API surface |
| `intent-audit-api-pci` | — | PCI intent audit over API surface |
| `intent-audit-report-gdpr` | — | GDPR compliance report |
| `culture-governance-guardrail` | — | Culture and governance policy gate |

### Voice

| Pipeline | pnpm shortcut | Description |
|---|---|---|
| `voice-learning-setup` | `pnpm voice:setup` | One-time voice profile setup (clone + register) |
| `voice-health-check` | `pnpm voice:health` | Verify voice engine availability |
| `clone-my-voice` | `pnpm voice:clone` | Generate a voice clone from recordings |
| `speak-with-my-voice` | `pnpm voice:speak` | TTS playback with cloned voice |
| `voice-hello` | — | Smoke test for voice output |
| `voice-instant-clone` | — | Quick single-sample voice clone |
| `voice-recording-session` | — | Guided recording session for voice training |

### Meeting

| Pipeline | pnpm shortcut | Description |
|---|---|---|
| `meeting-facilitation-workflow` | — | Full meeting facilitation (join → transcribe → summarize) |
| `meeting-facilitation-postprocess` | — | Post-meeting processing (transcript → action items) |
| `meeting-proxy-workflow` | — | Voice-proxy meeting attendance |
| `meet-join-with-cloned-voice` | — | Google Meet join with cloned voice |
| `zoom-join-with-cloned-voice` | — | Zoom join with cloned voice |
| `teams-join-with-cloned-voice` | — | Microsoft Teams join with cloned voice |

### Delivery & Code

| Pipeline | pnpm shortcut | Description |
|---|---|---|
| `project-kickstart` | — | Autonomous project lifecycle starter (Concept → Req → Design → Tasks → Repo) |
| `code-review-cycle` | — | AI-assisted code review with wisdom ops |
| `deploy-release` | — | Release preparation (changelog + tag + PR) |
| `incident-post-mortem` | — | Structured post-mortem report generation |
| `daily-summary` | — | Daily activity and task summary |
| `schedule-summary-and-coordination` | — | Weekly schedule synthesis and coordination |

### Mobile & Web Handoff

| Pipeline | pnpm shortcut | Description |
|---|---|---|
| `mobile-webview-handoff-runner-android` | — | Android runtime handoff capture → browser import orchestration |
| `mobile-webview-handoff-runner-ios` | — | iOS runtime handoff capture → browser import orchestration |
| `web-session-handoff-runner` | — | Web runtime handoff export → import orchestration |

### Chaos & Resilience Tests

| Pipeline | Description |
|---|---|
| `chaos-actuator-down` | Simulates actuator failure; validates fallback behaviour |
| `chaos-network-partition` | Simulates network partition; validates retry/circuit-breaker |
| `chaos-repair-test` | Validates self-repair after injected fault |
| `chaos-secret-missing` | Simulates missing secret; validates secret-guard error path |

## Creating Custom Pipelines

Canonical runtime pipelines use the JSON ADF shape:

```json
{
  "action": "pipeline",
  "name": "Pipeline Name",
  "steps": [
    { "op": "system:log", "params": { "message": "hello" } }
  ]
}
```

Legacy `.yml` skill-chaining files may still exist as historical artifacts, but they are not the primary runtime contract.

## Op Syntax Reference

Every step `op` in a top-level pipeline must use the **`domain:action`** format. The `domain` is the actuator name minus the `-actuator` suffix.

```json
{ "op": "media:pptx_render" }     // → media-actuator, op=pptx_render
{ "op": "wisdom:knowledge_search" } // → wisdom-actuator, op=knowledge_search
{ "op": "system:shell" }           // → built-in runner
{ "op": "core:if" }                // → built-in control flow
```

Bare names (no `:`) are normalized to `system:<op>`. This means `{ "op": "log" }` silently routes to the system actuator — not the actuator you likely intended.

### media-actuator: two invocation contexts

`media-actuator` is unique: it exposes a sub-pipeline interpreter with its own op set (`set`, `merge_content`, `apply_theme`, `pptx_render`, etc.). These ops use **bare names inside the media-actuator's own step loop**, but require the `media:` prefix when called from a top-level pipeline.

| Where written | Required syntax | Why |
|---------------|----------------|-----|
| Top-level pipeline JSON | `"op": "media:set"` | Runner does `domain:action` split to load the actuator |
| `examples/` inside `media-actuator/` | `"op": "set"` | Consumed directly by `executePipeline`, no domain resolution needed |

When in doubt, use `media:` — the runner wraps your step into a single-step sub-pipeline and passes it to `media-actuator` transparently.

### service-actuator: preset calls

Service presets keep auth and endpoint details inside the preset catalog. Use `service:preset` at the top level, then pass the service call inside `params`.

```json
{
  "op": "service:preset",
  "params": {
    "service_id": "backlog",
    "operation": "get_issues",
    "auth": "secret-guard",
    "params": {
      "space": "your-space",
      "query": { "projectId[]": [12345], "count": 50 }
    }
  }
}
```

Backlog uses `auth_strategy: "api_key_query"` with `BACKLOG_API_KEY` stored via `secret:set`.
Pipeline-level `retry` overrides are merged with the actuator manifest and the preset `recovery_policy`.

## Path Security

Output paths must be within the project root. Use `active/shared/tmp/` or `active/shared/exports/` as staging areas; copy files externally with a `system:shell` step after rendering.

`[ROLE_VIOLATION]` errors mean the active persona/role does not have access to the requested path. Check the policy at `knowledge/public/governance/security-policy.json`.
