---
category: Changed
---

- **Intent heuristics read a locale-keyed phrase lexicon** — the ~110 hardcoded Japanese/English `/…/i.test()` literals behind intent classification (browser conversation commands, task-session payload hints, contextual intent frames, intent resolution scoring, execution / guided-coordination briefs, mission role hints, procedure self-repair) now resolve concept ids through `matchesIntentPhrase(text, conceptId)` (`@agent/core`). Phrases live in `knowledge/product/governance/intent-phrase-lexicon.json` (schema `intent-phrase-lexicon.schema.json`), keyed by locale; all locales are checked by default, so adding a language is a JSON edit. Decisions are unchanged (parity test against the captured old regex outputs); patterns are compiled once and nested quantifiers are rejected.
