---
title: 'Agent Mistake Correction Playbook — encode recurring errors so the next agent cannot'
tags: [orchestration, engineering, hygiene, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, review]
---

# Agent Mistake Correction Playbook

Distilled from pstack `/correct` + Encode Lessons in Structure (MIT; see
[pstack-import-map](./pstack-import-map.md)). Complements
[operations-hygiene-runbook](../governance/operations-hygiene-runbook.md) (operational defect
classes) and [kyberion-development-practices](../governance/kyberion-development-practices.md)
(registration ceremonies). Use when the **operator keeps correcting agents for the same coding
or procedure mistakes**.

Assume every contributor is an agent that sees only the files it opened, copies the nearest
example, and takes the shortest path that compiles. Design the repo so a change that looks right
from one file is right for the whole repo.

## Steps

1. **Find mistake classes** from recent commits, reverts, review comments, agent instruction
   files, and workaround comments. A class counts once it has happened twice.
2. **Fix each class at the highest level that works** (stop at the first that holds):
   1. Architecture — one owner per state; one supported way; hide internals so the wrong import
      fails; one source of truth; delete old ways agents would copy
   2. Types — illegal states unrepresentable
   3. Lint / CI — error names the file/type/function to use; fail only on newly added instances
      when the pattern is already common
   4. Tests — fail when the behavior breaks; pass when only internals change
   5. Docs / agent rules **last**, only for judgment calls (nothing fails when skipped)
3. **Prove** each new check fails on a real past mistake. Same command locally and in CI.
   Exceptions: offending line + reason + expiry + human approval.
4. **Keep a rule↔enforcement table** (extend ops hygiene or development practices in the same PR).
   When the operator corrects you again: fix the mistake and add/strengthen the rule. If the rule
   was already written and nothing enforces it, that is a repeat — raise the level in the same
   change. Drop a rule once its mistake cannot happen.

## Reply shape

Each class with evidence, the level chosen, why a higher level did not work.
