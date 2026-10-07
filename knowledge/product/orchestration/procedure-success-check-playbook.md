---
title: Procedure Success Check Playbook (golden scenarios)
category: Orchestration
tags: [orchestration, procedure, golden-scenario, verification, browser, service, knowledge_steward]
importance: 6
last_updated: 2026-10-07
kind: playbook
scope: global
---

# Procedure Success Check Playbook

A recorded procedure (browser or service) that reports `executed` has only **run** — it has not necessarily **worked**. Each procedure carries a **golden scenario**: the success conditions captured when its recording was promoted. After every run the run's own evidence is checked against it, and the verdict is recorded on the knowledge-verification ledger for the procedure's recording.

Japanese operator aid: [procedure-success-check-playbook.ja.md](./procedure-success-check-playbook.ja.md).

## 1. What happens automatically

| When                                                            | What                                                                                                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Promotion (`promote_procedure`, service/browser promotion)      | The golden scenario is saved to `<catalog dir>/golden/<procedure_id>.v<version>.json` and linked from the catalog entry (`golden_scenario_ref`).                        |
| Run — `service:preset`                                          | Each expected response value must actually come back non-empty (a finished step with an empty response fails).                                                          |
| Run — Playwright                                                | A read-only page snapshot is taken as the last step; only that snapshot is checked.                                                                                     |
| Run — Chrome extension                                          | After a completed run the extension sends only the page elements matching a condition; the native host judges them (`submit_golden_evidence`). Each run is judged once. |
| Every Sunday 03:00 (`pipelines/knowledge-curation-weekly.json`) | The procedure check report is written to `knowledge/personal/governance/PROCEDURE_CHECK_REPORT.md` (personal tier; never the public `CURATION_REPORT.md`).              |

## 2. Reading a verdict

| Verdict        | Meaning                                                                                                                       | Recorded as                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pass`         | A strong condition (a named value or visible text) was met and nothing was unmet.                                             | verified run, `evidence: golden` — workers see "passed its success check"                |
| `fail`         | A condition was not met.                                                                                                      | problem `failed_check` with the unmet condition — workers see "failed its success check" |
| `inconclusive` | The evidence could not decide: unsupported condition (e.g. screenshot comparison), missing evidence, or only weak conditions. | nothing — a false pass is worse than no verdict                                          |

Weak conditions never pass a run on their own: "a button was visible" with no text, the last service step merely finishing, or the compiler's fallback "the control just clicked is still visible" (`params.anchor: last_action_target`).

## 3. Commands

```bash
pnpm kyberion procedure golden status            # every procedure, failures first, with what to do
pnpm kyberion procedure golden status --json
pnpm kyberion procedure golden backfill --dry-run   # procedures promoted before golden scenarios existed
pnpm kyberion procedure golden backfill             # create and link them
pnpm kyberion procedure golden backfill --catalog knowledge/personal/procedures.json
```

`backfill` rebuilds the golden scenario from the procedure's own reviewed recording and changes nothing in the catalog entry except `golden_scenario_ref`.

## 4. What to do per status

| Status                   | Action                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no_golden_scenario`     | Run `backfill` (`--dry-run` first).                                                                                                                                                                            |
| `weak_only`              | No run can ever pass. Re-record and include a step that anchors on the visible result — wait for the completion message (`wait_for_ref`) or extract the result text (`extract_text_ref`) — then promote again. |
| `failed_check`           | The procedure ran but did not reach the success state. Check the site/service for a change, then fix (self-repair delta) or re-record.                                                                         |
| `reported_problem`       | A person reported it wrong/stale. Fix or supersede.                                                                                                                                                            |
| `changed_since_verified` | The recording changed after it last passed. Run it once to confirm the new version.                                                                                                                            |
| `never_passed`           | Has a usable golden scenario but no passing run yet. Run it once.                                                                                                                                              |

## 5. Recording procedures that can be checked

- End the recording on the **result**, not the last click: wait for the confirmation (`wait_for_ref` on the status message) or extract a value that proves success.
- Prefer text that only appears on success ("Request approved", an issue key) over generic controls.
- For service recordings, make sure the step that produces the important value names its output channel; that channel becomes the success condition.

## 6. Troubleshooting

- **The weekly log says the procedure check report was skipped**: the personal tier is written only by the operator's persona (`personal` / `sovereign`). Run the weekly pipeline as the operator, or use `status` from your own terminal.
- **`status` shows no procedures** although you have some: the command reads the personal catalogs only when your persona may read the personal tier.
- **Extension run shows "could not judge"**: the page returned no evidence (e.g. it navigated away); nothing is recorded. Run it again on a stable page.
- **Always `inconclusive`**: the golden scenario has only unsupported or weak conditions — see `weak_only` above.

Related: [knowledge_steward PROCEDURE §E](../roles/knowledge_steward/PROCEDURE.md) (ledger rules), [browser-automation-best-practices](./browser-automation-best-practices.md).
