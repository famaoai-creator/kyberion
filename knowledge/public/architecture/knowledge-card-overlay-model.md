---
title: Knowledge Card, Overlay, and Policy Graph Model
category: Architecture
tags: [architecture, knowledge, taxonomy, overlay, policy, retrieval]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-15
kind: architecture
scope: repository
authority: reference
phase: [alignment, execution, review]
role_affinity: [knowledge_steward, ecosystem_architect, solution_architect]
applies_to: [knowledge, retrieval, governance]
owner: knowledge_steward
status: active
---

# Knowledge Card, Overlay, and Policy Graph Model

## 1. Goal

Reorganize Kyberion knowledge so that:

1. rules are explainable
2. retrieval is context-aware
3. mission-local exceptions do not pollute global knowledge
4. tier isolation remains physically enforceable

## 2. Core Model

Kyberion should treat knowledge as three coordinated layers:

1. `Knowledge Card`
2. `Overlay Model`
3. `Policy Graph`

## 3. Knowledge Card

A Knowledge Card is the atomic retrieval unit.

Each card should describe:

- what kind of knowledge it is
- how authoritative it is
- what scope it applies to
- which roles, phases, or capabilities should retrieve it first

### 3.1 Required metadata

- `kind`
- `scope`
- `authority`
- `phase`
- `role_affinity`
- `applies_to`
- `owner`
- `status`

Tier is inferred from the physical path:

- `knowledge/public/` => `public`
- `knowledge/confidential/` => `confidential`
- `knowledge/personal/` => `personal`

## 4. Overlay Model

Retrieval should not treat all cards equally.

Kyberion composes overlays in this order:

1. `global`
2. `repository`
3. `mission`
4. `environment`

More specific overlays may tighten guidance or add temporary constraints, but should not silently weaken higher-authority policy.

### 4.1 Overlay examples

- mission-local delivery constraint
- repository-specific build rule
- environment-specific runtime limitation
- personal execution preference

## 5. Policy Graph

Not all knowledge is reference material.

`governance` cards and policy artifacts form a Policy Graph:

- nodes express rules or gates
- edges express dependency or supersession
- policies are evaluated before retrieval results are applied to execution

Examples:

- tier isolation
- approval requirements
- compliance restrictions
- mission-local prohibitions

## 6. Retrieval Model

Retrieval should use:

1. `tier gate`
2. `scope priority`
3. `kind relevance`
4. `phase relevance`
5. `role affinity`
6. `authority weight`
7. `content relevance`

This allows:

- design work to prefer `architecture` and `standards`
- execution work to prefer `capability` and `playbook`
- audit work to prefer `governance` and `standards`

## 7. Taxonomy Guidance

Recommended meaning of `kind`:

- `governance`
- `standard`
- `architecture`
- `capability`
- `role`
- `playbook`
- `incident`
- `reference`

Recommended meaning of `authority`:

- `policy`
- `standard`
- `recipe`
- `reference`
- `advisory`

Recommended meaning of `scope`:

- `global`
- `repository`
- `mission`
- `environment`

## 8. Directory Strategy

Directory structure still matters for human navigation, but metadata is the primary machine contract.

Folders should optimize readability.
Cards and indexes should optimize retrieval.

## 9. Migration Strategy

1. add card metadata to representative documents
2. update retrieval to score `kind`, `scope`, `authority`, and `phase`
3. keep compatibility aliases while path migrations continue
4. move old `skills` knowledge into `capability` or `reference` categories
5. promote governance artifacts into explicit policy graph nodes where needed
