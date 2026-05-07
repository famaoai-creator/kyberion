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
