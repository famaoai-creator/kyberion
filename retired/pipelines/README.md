Retired pipeline definitions are kept here for historical reference only; active runtime discovery and validation should use `pipelines/` or `knowledge/product/pipeline-templates/`.

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
