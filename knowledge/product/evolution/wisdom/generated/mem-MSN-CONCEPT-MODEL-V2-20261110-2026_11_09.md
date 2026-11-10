---
record_id: mem-MSN-CONCEPT-MODEL-V2-20261110-2026_11_09
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CONCEPT-MODEL-V2-20261110-2026_11_09
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-09T16:04:45.474Z
source_branch: feat/concept-model-v2-20261110
source_commit: cf3c1bdaec9fd00d3a8a55b05d0b63330ae79946
---

# Changing what a concept means: decide first, mark transitioning, then migrate code

When a concept meaning is decided ahead of the code, record an ADR, write the decided meaning into concept-registry and GLOSSARY at once with lifecycle transitioning (decision + plan) or deprecated (replaced_by), and label current behaviour as transitioning instead of describing the old meaning as current.

## Hint Scope

mission

## Trigger Phrases

- - Decide first, migrate later: an ADR fixes the meaning; registry/GLOSSARY carry the decided definition with lifecycle transitioning + plan; dropping lifecycle is the done signal per plan.
- Before designing a "new" primitive, look for an existing one: libs/core/lease/ (LeaseBackend) and the store-grant / information-asset scope designs already existed, so the plans extend them instead of adding parallel modules.
- Order migrations by dependency: scope/Grant first, since memory disclosure and routing authority sit on it.
- Prettier wraps long YAML flow lists in frontmatter (concepts: [..]) onto several lines; any gate that parses frontmatter lists must fold wrapped flow and block lists.
- Doc-edit scripts: never pass user text as a String.replace replacement string. "$`" inside it (e.g. a regex ending in $ followed by a backtick) inserts the text before the match and silently duplicated GLOSSARY.md (793 -> 1485 lines). Use split/join or a replacement function, and sanity-check diff size.

## Recommended References

- active/missions/public/MSN-CONCEPT-MODEL-V2-20261110/evidence/distillation.md

## Evidence

- active/missions/public/MSN-CONCEPT-MODEL-V2-20261110/evidence/distillation.md

## Artifacts
