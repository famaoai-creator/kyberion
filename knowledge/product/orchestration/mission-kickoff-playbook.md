---
title: 'Mission Kickoff Playbook — friction-free mission start for repo-internal work'
tags: [orchestration, mission, lifecycle, kickoff, playbook]
last_updated: 2026-11-23
runtime_stages: [alignment, execution]
---

# Mission Kickoff Playbook

The shortest reliable path from "this needs a mission" to an ACTIVE mission with a
working task list. Written from MSN-LOG-OPT-20260930 — every stumble below cost real
round-trips; follow the sequence and none of them recur.

## 1. Canonical sequence (repo-internal / public tier)

```bash
pnpm mission create MSN-<TOPIC>-<YYYYMMDD> --tier public
pnpm mission start <ID> \
  --goal "<what the user actually wants>" \
  --success-condition "<observable acceptance criteria>"
# work through NEXT_TASKS.json phases; each task auto-completes when its
# deliverable exists under evidence/ and you run:
pnpm mission record-evidence <ID> <task_id> "<note>" --actor-id <your-agent-id>
# dev/refactor missions include a docs-sync delivery task:
pnpm check:docs-impact --out evidence/docs-sync-report.md   # close every finding
# review-kind tasks additionally need an independent reviewer:
pnpm mission review-task <ID> <review_task_id> <different-agent-id> --findings '<json>'
# verify refuses while non-delivery/retrospective tasks are open (lists them);
# override only deliberately: --allow-open-tasks "<reason>" (recorded in history)
pnpm mission verify <ID> verified "<why the success condition holds>"
pnpm mission distill <ID>
# before the PR: curate the product lesson and promote it into the PR branch
pnpm mission memory-approve <candidate_id> --knowledge-domain product \
  --approval-channel pr_review --curation-json '<json>'
pnpm mission memory-promote <candidate_id> --target-root <feature worktree>
# commit it, then scaffold the PR body instead of hand-authoring the contract:
#   pnpm kyberion pr body --out .github/pr-body.md   # fills Mission ID + Knowledge lines
# edit the scaffold (Summary/Test plan/pending candidates), then
#   pnpm kyberion pr create --body-file .github/pr-body.md
# after merge: record delivery + retrospective, git fetch origin main, then
pnpm mission finish <ID>   # ratifies pr_review candidates against origin/main
```

### Fresh worktrees — build before you verify

A dedicated worktree starts with no `node_modules/` and no `dist/`, and every
verification command (`pnpm typecheck`, `pnpm check -- --changed`, `pnpm mission`,
`pnpm kyberion pr create`) runs compiled output — so build once, up front:

```bash
pnpm prepare:worktree   # install + build:packages + build:repo (or `pnpm build` for the full build incl. UI)
```

Skipping this surfaces as three separate failures: `pnpm --filter @agent/core run build`
fails because `@agent/kernel` is unbuilt, `pnpm typecheck` fails on missing
`@agent/shared-*` package dist, and `pnpm check -- --changed` fails ~12/76 gates on
absent `dist/scripts/` — all cleared by the single command above.

Organization routine ops (weekly digest, moderation triage report) should prefer the
short ops-report process instead of the code-change template:

```bash
pnpm mission kickoff MSN-<TOPIC>-<YYYYMMDD> \
  --tier confidential --tenant-slug <tenant> \
  --organization-id <org> \
  --mission-type operations_report \
  --goal "<ops report goal>" \
  --success-condition "<report + organization operation run recorded>"
```

`--organization-id` selects organization defaults via `KYBERION_ORGANIZATION_ID`. It
does **not** switch customer stance unless `knowledge/personal/stances/<org>/` exists.

Learnings ship in the same PR as the code — see
[execution.md step 5](../governance/phases/execution.md) and
[review.md](../governance/phases/review.md#product-lessons-ship-inside-the-code-pr).

### Review-target authorship

A deliverable's existence does not identify its producer. Tasks referenced by
`review_target` need their own actor-bearing `record-evidence` before cascading
completion; recording an earlier task does not assign its author to later work.
For an older auto-completed target with missing provenance, record evidence on
that target as its actual producer, then rerun `review-task` with a different
reviewer. Recording evidence on the review task cannot establish target
authorship. A verified current task claim may supply an omitted actor ID; an
explicit conflicting actor or forged/stale claim is still rejected.

### Mission dependencies

Declare missions that must finish first with `--prerequisites MSN-A,MSN-B` on
`create` / `kickoff` / `start` (ids are case-insensitive and stored uppercase in
`relationships.prerequisites`). A prerequisite is satisfied once its mission is
`completed` or `archived`; archived missions are found in the archive
(`mission-management-config.json` `directories.archive`). An unmet prerequisite
makes `start` fail with `[MISSION_PREREQUISITES_UNMET]` and a non-zero exit.
`--force` bypasses predecessor completion. `enqueue <ID> <tier> [priority] [deps]`
adds queue-level dependencies. During `dispatch`, a missing prerequisite keeps
the entry pending and lets the same sweep examine the next candidate.

Preview scope and prerequisites with `pnpm mission start <ID> --dry-run --json`.
Use `input.preflight.ready` to decide whether to start. Use
`pnpm mission gate-pass <ID> <GATE_ID> --machine-only --dry-run --json` to preview
startup and the stored gate definition. The actual machine gate evaluates its
checks and starts through the Mission lifecycle before advancing the phase.
A prepared WorkItem admission requires its bound activation path; a journal
with uncertain effects requires reconciliation before replay.

## 2. Pitfalls hit (and the fix)

| Stumble                                                                         | Why it happens                                                                                                                 | Fix                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create` fails with `[SCOPE_CONTEXT_INVALID] … requires --tenant-slug`          | `create` defaults to the **confidential** tier, which needs tenant context                                                     | Repo-internal work → pass `--tier public`. (Fixed in MSN-KICKOFF-UX-20260930: the hint itself now names `--tier public`.)                                                                                                                                                                                                                                                         |
| Mission ID has no suggested format                                              | `create` requires you to invent the ID                                                                                         | Convention is `MSN-<TOPIC>-<YYYYMMDD>` (see `pnpm mission list`). Pick a short uppercase topic. (Fixed in MSN-KICKOFF-UX-20260930: ID errors and `create` help now state the convention.)                                                                                                                                                                                         |
| NEXT_TASKS appear from nowhere                                                  | `create` auto-expands a process template (e.g. `code-change-aidlc` → 8 phased tasks)                                           | Read `NEXT_TASKS.json` once — phases are alignment → planning → contract_authoring → execution → test → self_review → delivery → retrospective, each with a `deliverable` path under `evidence/`.                                                                                                                                                                                 |
| Unsure how tasks close without dispatch                                         | `record-evidence` is the direct-work path                                                                                      | Write the task's `deliverable` file first, then `record-evidence` auto-completes it **only when the task's dependencies are already completed** — record in dependency order. Never hand-edit task status.                                                                                                                                                                        |
| `review` tasks don't close on `record-evidence`                                 | Independence must come from the ledger, not self-declaration                                                                   | Review with a _different_ agent id (a subagent works), then `review-task … --findings '[{severity,category,description,…}]'`.                                                                                                                                                                                                                                                     |
| `pnpm typecheck` is green but `libs/core` has real type errors                  | Root `tsc --noEmit` does not cover `libs/core` — the package builds via its own tsconfig                                       | Always run `pnpm --filter @agent/core run build` alongside `pnpm typecheck` when touching `libs/core`.                                                                                                                                                                                                                                                                            |
| `--help` output is long; `--tier` is far below the lifecycle commands           | Global options print after the command list                                                                                    | Skim the options tail of `mission_controller --help` once; `--tier`, `--tenant-slug`, `--decided-by` all live there.                                                                                                                                                                                                                                                              |
| create + start needs two commands                                               | `create` only marks the mission planned                                                                                        | Fixed in MSN-KICKOFF-UX-20260930: `pnpm mission kickoff <ID> --tier public --goal … --success-condition …` is the one-step entry (shares the `start` path).                                                                                                                                                                                                                       |
| `kickoff` fails with tenant path policy on `active/missions/confidential`       | Prerequisites used to mkdir the bare confidential prefix while `KYBERION_TENANT` required a tenant segment                     | Fixed: prerequisites create `active/missions/confidential/{tenant}` when a tenant is selected.                                                                                                                                                                                                                                                                                    |
| `--organization-id` breaks identity prerequisites                               | `withOrganizationContext` used to set `KYBERION_STANCE` for every org id, so stance overlay hid `knowledge/personal/` identity | Fixed: org id sets `KYBERION_ORGANIZATION_ID`; customer stance switches only when `knowledge/personal/stances/{slug}/` exists.                                                                                                                                                                                                                                                    |
| Ops report missions expand into `code-change-aidlc` (8+ phases)                 | Default `--mission-type` is `development`                                                                                      | Use `--mission-type operations_report` for organization digests / routine ops evidence (3 phases: draft → record → review).                                                                                                                                                                                                                                                       |
| Document work expands into `code-change-aidlc` (asks for build/PR)              | Same default; a manual/deck/video job lands in `code_change`/`single_artifact` without review of readability or design         | Use `--mission-type document_production` (→ `content_and_media`/`document-authoring`: audience → outline → draft → review → render → evaluate → repair → publish). Deck/video: `presentation_production` / `video_production`.                                                                                                                                                    |
| Spec extraction / legacy rebuild expands into `code-change-aidlc`               | Default `--mission-type development` treats it as feature work, so no denominator, citation or parity gates apply              | Use `--mission-type reverse_spec` (→ `reverse-spec-extraction`: scope → code graph → analysis → specify → independent audit) to extract specs from existing code, then `--mission-type legacy_migration` (→ `legacy-migration-rebuild`) to rebuild from an audited `rebuild`-purpose spec. Utterances such as 「既存コードから仕様を抽出」「レガシー移行」 promote automatically. |
| Meeting recordings land in a `development` mission (8-9 code tasks never close) | `minutes:record` required `--mission`, and missions default to `development`                                                   | Omit `--mission`: `pnpm minutes:record` creates `MSN-MEETING-<YYYYMMDD>-<HHMM>` as `meeting_facilitation` (tenant → confidential, else personal). It needs a standing `meeting.recording` grant via `--meeting-series`/`--meeting-url`. A passed `--mission` is never retyped.                                                                                                    |

## 3. Distilled learnings carried over (MSN-LOG-OPT-20260930)

- One canonical engine + facades beats migrating every call site (logging-policy.md is now the governing doc).
- Construction noise belongs at `debug` at the call site; dedup is a safety net, not the fix.
- Omit empty fields at write time in observability streams; keep audit at full fidelity (compact only re-derivable bulk data into count+digest).
- Reproduce before editing: a real `baseline-check` run gave the measurable before/after (≈40 → 6 lines).
- When production calls a new logger method, every test mock of that logger needs it too — inject `debug` into all `logger:`/`createLogger` mock literals. CI `logger.debug is not a function` failures on this mission were exactly this class; verify with the full vitest suite locally before pushing.

## 4. Still-open improvement candidates for the controller

- ~~`startMission` swallows failures (`catch → logger.error`, exit 0)~~ **fixed**: `start` rethrows pre-activation failures (verified live: `[SCOPE_CONTEXT_INVALID]` exits 1 via `[ELIFECYCLE]`).
- `review-task --findings` accepts only the documented schema — `{severity: "blocking"|"suggestion", category, description, required_action?, location?}` — extra keys or other severities are rejected before a receipt is written (verified 2026-10-08; the rejection is validation, not a parse bug).
- `record-evidence` used to leave dependents stuck when a review task closed later (observed as "Pending tasks remain" at finish); task auto-completion now cascades to deliverable-satisfied dependents (MSN-BASELINE-STALEDIST-20261008 / MSN-ORGLIST-DEGRADE-20261008 friction, fixed same cycle).
- Auto-generating mission IDs (`create --auto` → `MSN-AUTO-<date>-<rand>`) was considered and left out — unpredictable IDs are worse than a printed convention.
