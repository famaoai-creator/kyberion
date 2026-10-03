---
record_id: mem-MSN-TRIGGER-LOOP-20261003-2026_10_03
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-TRIGGER-LOOP-20261003-2026_10_03
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-03T03:38:07.533Z
source_branch: devin/trigger-loop-20261003
source_commit: 5b102cfceda54330da07733bc429a7816f7af64e
---

# Wiring a new trigger into the dot/pipeline runtime — registration and semantics checklist

When adding a new core module, CLI subcommand, or trigger kind, implementation is not complete until the registration ceremonies are done: libs/core/package.json exports entry (or ERR_PACKAGE_PATH_NOT_EXPORTED at runtime), cli-commands.json + user-facing-vocabulary key + generate:pseudo-locale + generate:vocabulary-types for new kyberion subcommands, and the compact-style JSON edits that keep generated-file diffs reviewable.

## Hint Scope

mission

## Trigger Phrases

- Lessons from wiring dot wake lanes end-to-end: (1) new libs/core modules need an explicit entry in libs/core/package.json exports — tsc passes but the ts-loader fails at runtime without it; (2) new `kyberion <noun> <verb>` commands need a cli-commands.json script_commands entry plus a user-facing-vocabulary key, then run generate:pseudo-locale and generate:vocabulary-types; (3) edit generated-style JSON (schemas, catalogs) by hand in the file's existing compact style — json.dump rewrites the whole file and makes diffs unreadable; (4) tests that call producers which write durable lanes (runChannelTurn → dot-inbox) must mock the append or they pollute the live runtime state that resident daemons read; (5) for 'changed' probes, compare against the last DELIVERED fingerprint derived from the wake ledger rather than the last evaluated fingerprint — eval-vs-delivery crashes otherwise lose wakes; keep a write-once baseline for first observation.

## Recommended References

- active/missions/public/MSN-TRIGGER-LOOP-20261003/evidence/retrospective.md
- active/missions/public/MSN-TRIGGER-LOOP-20261003/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-TRIGGER-LOOP-20261003/evidence/distillation.md

## Evidence

- active/missions/public/MSN-TRIGGER-LOOP-20261003/evidence/retrospective.md
- active/missions/public/MSN-TRIGGER-LOOP-20261003/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-TRIGGER-LOOP-20261003/evidence/distillation.md

## Artifacts
