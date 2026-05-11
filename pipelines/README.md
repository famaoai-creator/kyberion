# Pipelines

実運用または共通オーケストレーション向けの JSON ADF pipeline を配置するディレクトリです。Execute via the built pipeline runner:

```bash
node dist/scripts/run_pipeline.js --input pipelines/<name>.json
```

Actuator 固有のサンプルや検証用 pipeline はここに置かず、各 actuator 配下の `examples/` へ配置します。

- Browser-Actuator examples: `libs/actuators/browser-actuator/examples/`

## Available Pipelines

| Pipeline                   | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `auto-audit`               | Quick automated project audit                               |
| `code-health`              | Code health assessment (mapping → quality → refactoring)    |
| `code-quality`             | Focused code quality scoring                                |
| `compliance-audit`         | License + regulatory compliance check                       |
| `cost-optimization-audit`  | Cloud cost analysis and waste detection                     |
| `data-flow-audit`          | Data flow and schema validation                             |
| `devsecops-continuous-compliance` | Advanced security and governance audit integrated into the lifecycle |
| `doc-analysis`             | Document analysis and extraction                            |
| `documentation-excellence` | Full documentation quality suite                            |
| `documentation-sync`       | Detect and fix documentation drift                          |
| `ecosystem-health-monitor` | Overall ecosystem health monitoring                         |
| `full-quality-gate`        | Comprehensive quality gate (security + code + tests + docs) |
| `full-security-audit`      | Deep security audit (scanner + supply chain + red team)     |
| `intelligent-code-review`  | AI-assisted code review pipeline                            |
| `knowledge-extraction`     | Extract knowledge from codebases and documents              |
| `project-kickstart`        | **[NEW]** Autonomous project lifecycle starter (Concept -> Req -> Design -> Tasks -> Repo) |
| `living-docs`              | Generate and maintain living documentation                  |
| `mobile-webview-handoff-runner-android` | Android runtime handoff capture -> browser import orchestration |
| `mobile-webview-handoff-runner-ios` | iOS runtime handoff capture -> browser import orchestration |
| `web-session-handoff-runner` | Web runtime handoff export -> import orchestration |
| `release-pipeline`         | Release preparation (changelog + security + PR)             |
| `security-audit`           | Standard security scan                                      |
| `team-onboarding`          | Generate onboarding materials for new team members          |

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

## Path Security

Output paths must be within the project root. Use `active/shared/tmp/` or `active/shared/exports/` as staging areas; copy files externally with a `system:shell` step after rendering.

`[ROLE_VIOLATION]` errors mean the active persona/role does not have access to the requested path. Check the policy at `knowledge/public/governance/security-policy.json`.
