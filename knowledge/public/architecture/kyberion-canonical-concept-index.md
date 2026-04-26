---
title: Kyberion Canonical Concept Index
category: Architecture
tags: [architecture, concept, canonical, intent, governance]
importance: 10
author: Codex
last_updated: 2026-04-26
---

# Kyberion Canonical Concept Index

## 1. Purpose

This document defines the canonical concept set for implementation decisions.
Use this as the first reference when concept documents appear to overlap.

## 2. Canonical User Vocabulary

Kyberion should default to the following four user-facing terms:

1. `Request`
2. `Plan`
3. `State`
4. `Result`

This is the stable interface contract at the human boundary.

## 3. Canonical Internal Primitives

Kyberion should treat the following seven objects as core implementation primitives:

1. `Project`
2. `Mission`
3. `Task Session`
4. `Artifact`
5. `Service Binding`
6. `Evidence`
7. `Memory Candidate`

## 4. Canonical Loop

The non-replaceable operating loop is:

```text
receive -> clarify -> preserve -> execute -> verify -> learn
```

Model providers, CLI hosts, and actuator internals may change.
Loop closure may not.

## 5. Document Roles

Use each document for a distinct purpose:

| Document | Canonical Role |
| --- | --- |
| `docs/USER_EXPERIENCE_CONTRACT.md` | user-facing language contract |
| `knowledge/public/architecture/organization-work-loop.md` | full organization loop model |
| `knowledge/public/architecture/enterprise-operating-kernel.md` | enterprise authority/accountability model |
| `knowledge/public/architecture/kyberion-concept-map.md` | layer mapping and concept placement |
| `docs/INTENT_LOOP_CONCEPT.md` | non-replaceable intent-loop closure model |

## 6. Reading Order

For onboarding and implementation alignment, read in this order:

1. `docs/USER_EXPERIENCE_CONTRACT.md`
2. `docs/INTENT_LOOP_CONCEPT.md`
3. `knowledge/public/architecture/organization-work-loop.md`
4. `knowledge/public/architecture/enterprise-operating-kernel.md`
5. `knowledge/public/architecture/kyberion-concept-map.md`

## 7. Implementation Rule

When a new feature is added, the implementation is concept-aligned only if:

1. It maps to one of the seven internal primitives.
2. It preserves the Request/Plan/State/Result user contract.
3. It can be explained in terms of the six-stage canonical loop.
