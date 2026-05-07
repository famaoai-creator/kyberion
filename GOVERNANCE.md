# Governance

How decisions get made in the Kyberion project.

## Principles

1. **Lazy consensus**: most decisions don't need a vote. If a PR has been open for 7 days with no objections from a core maintainer, it can be merged.
2. **Transparent disagreement**: when there is disagreement, it gets raised in writing (GitHub Issue or Discussion), not in DMs.
3. **BDFL during pre-1.0**: until v1.0.0, the founding maintainer (`@famaoai-creator`) holds final say on direction. After v1.0.0, governance shifts to the model below.

## Decision Types

| Decision | Who decides | Default mode |
|---|---|---|
| Code change in an unowned area | Author + 1 core maintainer review | Lazy consensus |
| Code change in an owned area | Author + the area's CODEOWNER | Lazy consensus |
| Adding a new actuator | Author + 1 core maintainer | Discussion first; merge after design feedback |
| Breaking change to a stable surface | All core maintainers must +1 | Explicit consensus required |
| Adding a maintainer | See [MAINTAINERS.md](./MAINTAINERS.md) | Per process there |
| Roadmap shift | Core maintainers, in a public Discussion | Open discussion → recorded decision |
| Code of Conduct enforcement | Core maintainers (private channel) | Confidential |

## Disagreement Resolution

If two contributors disagree on a code change:

1. **Discuss in the PR**. Most disagreements resolve here with one party providing more context.
2. **Escalate to a Discussion**. If the disagreement is about direction (not just tactics), open a Discussion thread.
3. **Vote among core maintainers**. Last resort. Each core maintainer gets one vote. Tie goes to the BDFL (pre-1.0) or to "no change" (post-1.0).

## Roadmap

The roadmap lives in `docs/PRODUCTIZATION_ROADMAP.md` and `docs/ROADMAP_ENGINE_REFINEMENT.md`. It is updated by core maintainers in PRs that go through the same review process as code.

Major direction shifts (Phase additions / removals, KPI changes, scope changes) require:

1. A Discussion thread describing the proposed shift.
2. At least 14 days for community feedback.
3. Core maintainer consensus on the final wording.

## Funding & Commercial Activity

Kyberion is OSS. No central funding entity. Individual maintainers may take paid FDE / implementation-support engagements using Kyberion. Such engagements:

- Must not bias maintainer decisions toward any one customer.
- Must not introduce closed-source dependencies into the core.
- May contribute generalizable improvements back to the project.

If commercial structures emerge (foundation, sponsored development), they will be documented here.

## Amending This Document

Changes to `GOVERNANCE.md` itself follow the "Breaking change" rule above: all core maintainers must +1.
