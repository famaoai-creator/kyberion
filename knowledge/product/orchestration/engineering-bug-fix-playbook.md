---
title: 'Engineering Bug Fix Playbook — reproduce, isolate, minimal fix, same-surface proof'
tags: [orchestration, engineering, bugfix, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification]
---

# Engineering Bug Fix Playbook

Distilled from pstack's Bug fix playbook (MIT; see [pstack-import-map](./pstack-import-map.md)).
Rewritten for Kyberion: mission evidence, actuators, and working principles — not Cursor Task routing.

Use when the work item is a **defect with observable wrong behavior**. One-line edits you already
understand do not need this playbook. Product-domain procedures stay under their own playbooks
(perception, browser site learning, etc.).

## Owner stance

You own the scientific integrity of the fix. Delegate investigation or a scoped patch when useful;
do not ship a change that only "might help." Every shipped line traces to runtime evidence.

## Steps

1. **Reproduce on the matching surface yourself.** Drive the same CLI, UI, actuator, or API the
   user hits. Prefer Kyberion perception/action paths (`pnpm kyberion read|see|listen|watch`,
   browser / system / terminal actuators) over ad-hoc parsers. Ask the operator to reproduce only
   after you have driven the surface as far as it goes, with a specific reason it cannot reach the
   target. If it will not reproduce, synthesize the trigger, tighten conditions, or instrument
   until it fires — do not guess.

2. **Binary-search the cause.** Form candidate hypotheses, then rule them out until one mechanism
   survives. Prefer reading the live subsystem and regression history over speculative patches.
   Each pass: take the split that cuts the most remaining problem space, gather runtime evidence,
   eliminate. When program state is unclear, add temporary instrumentation, run, and read the
   output. Confirm the surviving _mechanism_ with runtime evidence before designing the fix.

3. **Attack the premise when shared assumptions fail.** If two or more fixes that share one
   premise have already failed the same gate, write the premise down and test it directly before
   another fix that assumes it (working-philosophy: Attack the Premise). Do not start the next
   patch until that check exists.

4. **Plan the minimal fix.** Prefer the smallest diff the evidence justifies. Cross a module or
   function boundary only with an explicit shape (types, ownership, call sites) settled first.
   Belt-and-suspenders that "might help" is a hypothesis, not a fix — it does not ship. When
   evidence refutes a hypothesis, revert what it motivated.

5. **Verify on the same surface.** The original repro must now pass. Unit tests show branch
   behavior, not bug absence. "Inconclusive" or wrong-surface is not a pass — flag it. Capture
   failing-then-passing command output (or UI evidence) as mission evidence.

6. **Sequence verifiable units in git history.** Prefer failing repro / failing test first, then
   the fix on top, when a cheap local test path exists. Skip expensive or unclear tests rather
   than inventing brittle ones. One change, one verification before the next.

7. **Record and close through governance.** Write the task deliverable, run
   `pnpm mission record-evidence … --actor-id <who>`, and keep review-kind tasks on an independent
   reviewer via `review-task`. Never mark `NEXT_TASKS.json` complete by hand.

## Reply shape

What was broken, root cause (mechanism), fix, how you verified — with failing-then-passing
evidence quoted or path-linked.

## Related

- [working-philosophy](../governance/working-philosophy.md) — Done requires evidence; Attack the
  Premise; Fix root causes
- [engineering-feature-playbook](./engineering-feature-playbook.md) — new behavior, not defects
- [engineering-investigation-playbook](./engineering-investigation-playbook.md) — read-only how/why
- [blast-radius-playbook](./blast-radius-playbook.md) — before shipping a small-looking risky diff
- [create-verification-skill-playbook](./create-verification-skill-playbook.md) — when the repo
  lacks a scripted way to drive the real surface
- [procedure-success-check-playbook](./procedure-success-check-playbook.md) — golden checks for
  recorded procedures (complement, not substitute)
