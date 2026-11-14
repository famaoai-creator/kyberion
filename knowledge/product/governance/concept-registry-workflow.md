---
title: 'Concept Registry Workflow: one definition per term, retire instead of accumulate'
tags: [governance, documentation, concepts, glossary, lifecycle, gate]
last_updated: 2026-11-09
role_affinity: [planner, implementer, reviewer]
runtime_stages: [alignment, execution, review]
---

# Concept Registry Workflow

Kyberion's vocabulary drifted because documents were only ever **added** (261 docs added vs 2
removed between 2026-08 and 2026-11), mostly by agent sessions with local context, while the
gates checked form (import direction, "was a doc touched") rather than meaning (is there one
definition per concept). The result was competing "canonical" indexes, a glossary that
contradicted itself (WorkItem, Stance, Channel), and plan indexes that silently stopped
growing. This workflow and the `concept-registry` gate make the meaning checkable.

## The three artifacts

| Artifact                                                                            | Role                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`concept-registry.json`](./concept-registry.json)                                  | One entry per high-confusion term: the single one-line definition, canonical doc, GLOSSARY anchor, owner modules, aliases, and `not_to_confuse_with`. A term or alias belongs to exactly one entry. A real homonym (e.g. Channel) is declared with `senses`. |
| [`docs/documentation-source-map.json`](../../../docs/documentation-source-map.json) | Which document is canonical / index / supporting / historical per category. Canonical-ness lives **only** here and in the registry — never in a doc's own frontmatter.                                                                                       |
| `doc_status` frontmatter                                                            | Retirement only: `superseded` (requires `superseded_by: <path>`) or `historical`. Absence means current. Separate from `authority` / `doc_authority` (the retrieval ranking ladder) and from improvement-plan `status` (plan progress).                      |

## What the gate enforces (`pnpm check --only concept-registry`)

1. **Registry integrity** — unique ids; a term/alias claimed by one entry only; canonical docs and owner modules exist; `not_to_confuse_with` ids exist. A term whose meaning was decided but whose code still lags carries `lifecycle`: `transitioning` (the definition is the decided target; needs an existing `decision` record and migration `plan`) or `deprecated` (needs `replaced_by` ids that are not themselves deprecated). Dropping `lifecycle` is the observable "migration done" signal.
2. **One glossary definition per term** — a GLOSSARY `###` heading base term appears once, unless every qualified heading (`Term (qualifier)`) is a declared sense.
3. **Glossary agrees with the registry** — every entry has a GLOSSARY heading; a registry term that is a row of the _Contributor vocabulary_ table must use the registry definition verbatim.
4. **Retirement is explicit** — `doc_status` is validated in every markdown file under `docs/`, `knowledge/product/` and `knowledge/public/`: only `superseded` or `historical`; `superseded` needs an existing, non-retired `superseded_by` (a **repo-root-relative** path, e.g. `knowledge/product/architecture/x.md`). Improvement plans never use `doc_status` — they have their own `status`.
5. **Retired docs are never authoritative** — a `superseded`/`historical` doc cannot be a source-map canonical / index / supporting entry, nor a registry `canonical_doc`. Move it to the category's `historical` list.
6. **New architecture docs map onto concepts** — every markdown file under `knowledge/product/architecture/` (including subfolders such as `decisions/`) declares `concepts: [<registry ids>]` (inline list) or a `doc_status`. Older docs are exempted by the shrink-only baseline [`concept-registry-baseline.json`](./concept-registry-baseline.json); an exemption that is no longer needed fails until removed (`node --import ./scripts/ts-loader.mjs scripts/check/check_concept_registry.ts --prune-baseline` only removes, never adds).
7. **Every monthly plan is indexed** — each `docs/developer/improvement-plans-YYYY-MM/` has a `README.ja.md` linking all of its plans, and the status canonical index links every monthly README.

The knowledge index also gives `doc_status: superseded|historical` documents `advisory`
retrieval authority and no recency credit (retiring a doc touches its `last_updated`, which must
not read as freshness). In metadata-weighted ranking the replacement therefore outranks the
stale doc; in lexical-only retrieval metadata only breaks ties, so the banner and the
`superseded_by` pointer remain the primary signal to a reader. Registry aliases must not have
their own GLOSSARY heading — an alias with its own definition is a second concept.

## Procedures

**Introducing or redefining a concept.** Search the registry and GLOSSARY first. If the term
exists, extend that entry and its canonical doc — do not write a parallel doc. If it is new and
likely to be confused, add a registry entry _and_ its GLOSSARY heading in the same change, then
reference its id from the architecture doc's `concepts:`.

**Changing what a concept means.** Record the decision (an ADR under
`knowledge/product/architecture/decisions/`), write the decided meaning into the registry and
GLOSSARY at once, and mark the term `lifecycle: transitioning` with the migration plan. Docs
describe the target and name today's behaviour as _transitioning_. They do not keep describing
the old meaning as current. [Concept Model v2](../architecture/decisions/2026-11-10-concept-model-v2.md)
is the first such decision.

**Writing a new architecture doc.** Declare `concepts: [...]` with the ids it explains. If no id
fits, that is the signal to register the concept first (or to put the doc elsewhere, e.g. a
plan or an evaluation).

**Replacing a doc.** Do not leave two current docs. Mark the old one `doc_status: superseded` +
`superseded_by`, add a one-line banner pointing at the replacement, lower its `importance`, and
move it to `historical` in the source map. Keep it for history; repoint navigation links
(COMPONENT_MAP, onboarding procedures) to the replacement.

**Starting a new month of plans.** Create `improvement-plans-YYYY-MM/README.ja.md` with the first
plan and link it from the status canonical index. Each new plan is linked from its month's
README in the same change.

## Related

- [documentation-source-map](../../../docs/documentation-source-map.json) · [GLOSSARY](../../../docs/GLOSSARY.md)
- [CONCEPT_CONSOLIDATION_PLAN](../../../docs/developer/improvement-plans-2026-10/CONCEPT_CONSOLIDATION_PLAN_2026-10-21.ja.md) — the code-side counterpart (duplicate implementations)
- [kyberion-development-practices](./kyberion-development-practices.md)
