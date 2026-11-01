---
title: 'Blast Radius Playbook — prove the one safety fact by running code'
tags: [orchestration, engineering, risk, verification, playbook, pstack]
last_updated: 2026-11-01
runtime_stages: [execution, verification, review]
---

# Blast Radius Playbook

Distilled from pstack `/blast-radius` (MIT; see [pstack-import-map](./pstack-import-map.md)).
Use before shipping a small-looking change you do not fully trust, or when an approval needs
"what else breaks." Listing callers is not the job — grep does that. The job is breakage grep
misses, proved by running code.

## Certainty ladder (climb as far as cheap)

1. You said so — worthless alone
2. Pointed at `file:line` or library source
3. Walked the bad case; it cannot reach
4. **Ran it** — script/test imports the real code and fails loud if wrong
5. Reproduced in the running app/surface

Prefer step 4+. A persuasive writeup without proof is not a deliverable.

## Steps

1. Read the change: symbols added/changed/deleted, including behavior the diff does not spell out.
2. **Find the one fact it is safe because of.** Most risky-looking changes are safe because of a
   single fact (e.g. "only drops already-dead cache entries"). Spend time here.
3. Look where grep stops: pinned library source, microtasks/teardown timing, wire formats, flags,
   code three hops downstream, other languages reading the same bytes.
4. Honest risks: chance × cost; keep confirmed; list cleared separately. Never invent callers.
5. **Prove the one fact** with a script or test; paste output into mission evidence.
6. Wide changes: fan out via [design-divergence-playbook](./design-divergence-playbook.md)
   (independent reviewers / best-of-N), merge only proven findings.

## Reply shape

- What it does (including non-obvious)
- The one safety fact + ladder step + proof (or `unproven`)
- Risks (breakage, `file:line`, likelihood, severity, how to check)
- Cleared checks
