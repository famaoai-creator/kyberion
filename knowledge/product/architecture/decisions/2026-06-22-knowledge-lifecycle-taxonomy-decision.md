---
title: Keep Nine Mission Classes and Treat `knowledge_lifecycle` as a Category
category: Architecture
tags: [adr, taxonomy, mission-classification, knowledge_lifecycle, decision]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-22
---

# Keep Nine Mission Classes and Treat `knowledge_lifecycle` as a Category

## Status

Accepted

## Context

`knowledge_lifecycle` appears throughout the intent catalog as a durable product category for query, distillation, promotion, tier hygiene, sanitization, retirement, and reconciliation work.
The open question was whether this category should become a tenth mission class, or whether it should remain a category that resolves into the existing nine mission classes.

The decision criteria from the roadmap were:

1. At least five distinct knowledge lifecycle intents must require a workflow or review design that materially differs from `research_and_absorption` and `decision_support`.
2. The distinction must change ownership, evidence, tier controls, or gates. A label-only difference is not enough.
3. Representative scenarios must show repeated misclassification or unsafe fallback under the nine-class model.

## Evidence

The current catalogs already show that `knowledge_lifecycle` is not a single execution family.

- `knowledge_lifecycle` appears 17 times in `knowledge/product/governance/standard-intents.json`.
- The same 17 entries appear in `knowledge/product/governance/intent-domain-ontology.json`.
- Those 17 intents distribute across four existing mission classes:
  - `research_and_absorption`: 12
  - `decision_support`: 1
  - `platform_onboarding`: 1
  - `operations_and_release`: 3

Representative examples:

- `knowledge-query` resolves as `research_and_absorption` with `direct_reply`.
- `review-text` and `contract-review` already route through `decision_support` or `research_and_absorption` with existing review gates.
- `register-presentation-preference-profile` routes through `platform_onboarding`.
- `sanitize-knowledge-for-public-tier`, `retire-stale-knowledge`, and `reconcile-knowledge-index` stay within existing `operations_and_release` / `research_and_absorption` designs.

The new end-to-end scenario pack added in Task 8 also validated that the representative user requests resolve cleanly through the existing taxonomy:

- Japanese and English schedule reads and schedule coordination
- plain text review and contract review
- PPTX and HTML theme import
- web concept creation
- diagnostics and recovery
- knowledge query and knowledge distillation
- onboarding and organization integration

That scenario set passed with deterministic workflow and review-gate expectations using the existing classes.

## Decision

Do not add a tenth mission class.

Keep the current nine mission classes and keep `knowledge_lifecycle` as a category / organizing label that maps into the existing mission classes.

## Rationale

The evidence does not meet the threshold for a new class.

- The category is already absorbed by existing classes with different intent-level semantics.
- Workflow and review differences are already expressed by:
  - intent resolution
  - mission classification
  - workflow catalog selection
  - review gate selection
  - work-scope promotion
- Adding a tenth class would duplicate behavior that already exists in the current taxonomy and would make operator UX more ambiguous without changing the actual governance outcome.

In short: the category is meaningful, but it is not a separate mission-class axis.

## Consequences

- The canonical mission class list remains at nine.
- Future `knowledge_lifecycle` work should continue to be modeled as category + mission class + workflow + review gate selection.
- Operator-facing copy should explain the concrete action and governance path instead of introducing a new taxonomy term.

## Alternatives Considered

### Add a tenth `knowledge_lifecycle` mission class

Rejected.

Reason: the evidence shows the category already spans multiple existing mission classes, and the current taxonomy can represent the differences without adding a new top-level class.

### Keep nine classes and add more intent-specific rules

Accepted.

Reason: this preserves the current class boundary while still allowing the catalog to route knowledge work into the correct workflow and review path.

## Follow-up

- Continue using `knowledge_lifecycle` as a category in the intent catalog and governance docs.
- Revisit this decision only if future evidence shows at least five distinct knowledge lifecycle intents that cannot be expressed cleanly through the existing nine classes, workflows, and gates.
