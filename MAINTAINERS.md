# Maintainers

The people who maintain Kyberion. Defined per OSS best practices: a clear list, with scope, contact, and review responsibilities.

## Roles

| Role | What they do |
|---|---|
| **Core maintainer** | Reviews PRs, sets direction, owns release. Has merge rights to `main`. |
| **Area committer** | Has merge rights for a specific area (e.g. one actuator, one pipeline family). Surface to area defined per-person. |
| **Triage** | Labels issues, asks clarifying questions, closes obvious duplicates. No merge rights but visible in CONTRIBUTING. |

Promotion path: Triage → Area committer → Core maintainer. Promotion is reviewed every 6 months. Active contribution + alignment with project direction are the criteria.

## Current Maintainers

### Core Maintainers

| Name | GitHub | Areas | Contact |
|---|---|---|---|
| Motonobu Ichimura (famao) | @famaoai-creator | All / direction | via GitHub: open an issue or DM @famaoai-creator |

### Area Committers

| Name | GitHub | Areas | Contact |
|---|---|---|---|
| _open_ | — | actuator authoring | — |
| _open_ | — | mission lifecycle | — |
| _open_ | — | knowledge / governance | — |

Open seats are filled by self-nomination + 30-day trial period (5 merged PRs in the area, no escalations).

### Triage

| Name | GitHub | Notes |
|---|---|---|
| _open_ | — | — |

## Scope Definitions

| Area | Files / paths |
|---|---|
| Actuator framework | `libs/actuators/*`, `schemas/*-action.schema.json`, `docs/developer/EXTENSION_POINTS.md` |
| Mission lifecycle | `scripts/mission_controller.ts`, `scripts/refactor/mission-*`, `libs/core/mission-*` |
| Knowledge / governance | `knowledge/public/governance/*`, `libs/core/tier-guard.ts`, `docs/developer/CUSTOMER_AGGREGATION.md` |
| Voice / surfaces | `presence/displays/*`, `satellites/voice-hub/*`, `libs/actuators/voice-actuator/*` |
| Build / release | `package.json`, `.github/workflows/*`, `scripts/check_*.ts`, `migration/*` |

## Becoming a Maintainer

1. **Triage**: open a PR proposing yourself, link to your last 3 useful GitHub interactions in this repo. Approval requires +1 from any core maintainer.
2. **Area committer**: nominate yourself in a GitHub Discussion, list the area, link to your last 5+ merged PRs in that area. 30-day trial. Approval requires +1 from a core maintainer + no -1 from another committer.
3. **Core maintainer**: nominated by an existing core maintainer. Requires consensus among current core maintainers.

## Stepping Down

A maintainer may step down at any time by editing this file and opening a PR. Inactive maintainers (no merges or reviews for 6 months) will be moved to "Emeritus" by core maintainers, with a courtesy ping first.

## Emeritus

| Name | Period | Areas |
|---|---|---|
| _none yet_ | — | — |

## Decision-Making

See [`GOVERNANCE.md`](./GOVERNANCE.md) for how disagreements are resolved.
