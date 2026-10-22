Retired pipeline definitions are kept here for historical reference only; active runtime discovery and validation should use `pipelines/` or `knowledge/product/pipeline-templates/`.

## 2026-09-16 evidence audit

| Pipeline                      | Rationale                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kyberion-product-intro.json` | No retained run journal, trace, or schedule receipt named this pipeline; repository-wide static references found only the pipeline itself and a render script's output-file slug, not an executable pipeline reference. |

The owner confirmed on 2026-09-16 that the intro output never reached acceptable
quality, so the companion ad-hoc renderer `scripts/kyberion_product_intro_render.ts`
was deleted as well. The retired definition still names that script in its
`description`; that reference is historical and no longer resolvable.

The audit checked retained `active/shared/runtime/pipeline-runs/*.jsonl`,
`active/shared/logs/traces/*.jsonl`, schedule state, intent maps, MCP/CLI
catalogs, package scripts, pipeline includes, tests, and repository source.
`baseline-check` and scheduled or essential self-operation pipelines were
explicitly excluded. The list is intentionally conservative.

## 2026-09-16 ADF / implementation drift

A second pass retired governed ADF that no longer matches how Kyberion actually
runs. User-facing copies that already live as templates were moved here instead
of remaining in `pipelines/` (self-ops only). Invalid or toy templates were
moved to `retired/pipeline-templates/`.

| Asset                                                                                                                                     | Rationale                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `browser/yahoo.json`, `yahoo1.json`, `yahoo3.json`, `yahoo4.json`, `sbi.json`                                                             | Draft `_draft: true` recording stubs; not in the procedure registry, journals, or tests.                              |
| `meeting-minutes-generator.json`                                                                                                          | Pre-E2E-01 audio→STT shell; production post-meeting path is `pipelines/meeting-followup.json`.                        |
| `contract-review.json`, `ceo-strategic-report.json`, `executive-narrative-bridge.json`, `marketing-content.json`, `create-my-avatar.json` | Duplicates of `knowledge/product/pipeline-templates/` copies; intent routing / presets already used the templates.    |
| `generate-masterclass-pptx.json`                                                                                                          | Nested pre-AR-01 media pipeline; layout sample moved to `scripts/generate_all_objects_layout_sample.ts`.              |
| `trial-narrated-report.json`                                                                                                              | Shell-heavy demo with no run journal; simplification notes already classified it as drift.                            |
| `kyberion-vtuber-narrated-demo.json`, `-submit.json`, `-collect.json`                                                                     | Promoted one-offs with hardcoded mission paths; canonical pattern is the template.                                    |
| `../pipeline-templates/artifact-collector.json`, `audit-example.json`, `project-kickstart.json`                                           | Toy / invalid ADF (`op: mkdir`, `find .env`, `cp pipelines/*.json`); never referenced outside the integrity manifest. |

## 2026-09-16 duplicate runtime copies

The live `meeting:join` and current voice-health behavior were merged into the
canonical templates before these runtime-directory copies were retired.

| Asset                                                               | Rationale                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meeting-facilitation-workflow.json`, `meeting-proxy-workflow.json` | User-facing workflows; canonical implementations now live under `knowledge/product/pipeline-templates/`.                                             |
| `voice-health-check.json`                                           | The `pnpm pipeline voice-health-check` preset now resolves to the canonical template.                                                                |
| `../pipeline-templates/ui-voice-browser-smoke.json`                 | Unreferenced static template sharing an ID with the active self-operation smoke pipeline; `pipelines/ui-voice-browser-smoke.json` remains canonical. |

## 2026-09-16 remaining scope cleanup

| Asset                              | Rationale                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `campaign-suite.json`              | Unreferenced one-step wrapper around `core:run_campaign_suite`; the governed CLI entrypoint is `pnpm kyberion campaign suite`. |
| `generate-design-system-demo.json` | Unreferenced shell-export demo; the maintained design protocol fragment and sample generator remain active.                    |

`meeting-watcher.json` and `media-produce-and-review.json` were not discarded:
both use current typed operations, and the latter has retained evidence of a
real PPTX and visual-review run. They moved to
`knowledge/product/pipeline-templates/` because they are user workflows rather
than Kyberion self-operations.

## 2026-09-16 governance v1 samples

Pre-AR-01 ADF toys under `knowledge/product/governance/pipelines/` moved to
[`../governance-pipelines/`](../governance-pipelines/).

## Entries retired by the orphan-wiring audit (OW-04, 2026-10-01)

| File                                      | Reason                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate-dt-security-proposal-pptx.json` | Customer-specific proposal build that hardcoded `knowledge/confidential/sbidt/...` inputs and a customer-named output in the public pipeline tier; no parameters, no caller, unrunnable without that tenant's files. |

## Entries retired by the orphan triage (OW wave 3, 2026-10-01)

Decision table: [`ORPHAN_DECISIONS_2026-10-01.md`](../../docs/developer/improvement-plans-2026-10/ORPHAN_DECISIONS_2026-10-01.md) (wave 3).

| File                                         | Reason                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kyberion-vtuber-narrated-demo-submit.json`  | One-off render for mission `MSN-KYBERION-VTUBER-VIDEO`: every input and output path is hard-coded under `active/missions/confidential/MSN-KYBERION-VTUBER-VIDEO/`, which no longer exists; no caller.       |
| `kyberion-vtuber-narrated-demo-collect.json` | Collect half of the same one-off render (reads the submit half's job ticket from that mission's evidence directory).                                                                                        |
| `meeting-minutes-generator.json`             | Superseded by `pipelines/meeting-followup.json` (transcript → minutes + action items + delivery pack) driven by `pnpm minutes:record`; its export step hard-coded paths and ignored its own context values. |
| `rg-01-reasoning-governance-validation.json` | RG-01 readiness check that only probed five files for existence; the reasoning policy, registry and schema are covered by the catalog and contract-schema gates.                                            |

## Entries retired by the final orphan wave (wave 4, 2026-10-01)

| File                               | Reason                                                                                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kyberion-config-provisioner.json` | Its only input, `knowledge/public/tmp-profile.md`, does not exist, so the first step fails; the README described it as "provision operator config from canonical defaults", which it never did. No caller. |
