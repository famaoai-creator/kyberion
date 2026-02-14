# Pipelines

Pre-built YAML pipelines that chain multiple skills into automated workflows. Execute via `mission-control`:

```bash
node mission-control/scripts/orchestrate.cjs --pipeline pipelines/<name>.yml
```

## Available Pipelines

| Pipeline                   | Description                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `auto-audit`               | Quick automated project audit                               |
| `code-health`              | Code health assessment (mapping → quality → refactoring)    |
| `code-quality`             | Focused code quality scoring                                |
| `compliance-audit`         | License + regulatory compliance check                       |
| `cost-optimization-audit`  | Cloud cost analysis and waste detection                     |
| `data-flow-audit`          | Data flow and schema validation                             |
| `doc-analysis`             | Document analysis and extraction                            |
| `documentation-excellence` | Full documentation quality suite                            |
| `documentation-sync`       | Detect and fix documentation drift                          |
| `ecosystem-health-monitor` | Overall ecosystem health monitoring                         |
| `full-quality-gate`        | Comprehensive quality gate (security + code + tests + docs) |
| `full-security-audit`      | Deep security audit (scanner + supply chain + red team)     |
| `intelligent-code-review`  | AI-assisted code review pipeline                            |
| `knowledge-extraction`     | Extract knowledge from codebases and documents              |
| `living-docs`              | Generate and maintain living documentation                  |
| `release-pipeline`         | Release preparation (changelog + security + PR)             |
| `security-audit`           | Standard security scan                                      |
| `team-onboarding`          | Generate onboarding materials for new team members          |

## Creating Custom Pipelines

See any `.yml` file in this directory for the format. Each pipeline defines:

```yaml
name: Pipeline Name
steps:
  - skill: skill-name
    args: --flag value
  - skill: another-skill
    depends_on: [skill-name]
```
