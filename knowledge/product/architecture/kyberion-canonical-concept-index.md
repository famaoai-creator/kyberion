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
| `knowledge/product/architecture/organization-work-loop.md` | full organization loop model |
| `knowledge/product/architecture/enterprise-operating-kernel.md` | enterprise authority/accountability model |
| `knowledge/product/architecture/organization-profile-model.md` | organization defaults and policy profile model |
| `knowledge/product/architecture/mission-team-composition-model.md` | mission team template and staffing binding model |
| `knowledge/product/orchestration/organization-selection-guide.md` | operator-facing organization switching guide |
| `knowledge/product/orchestration/README.md` | orchestration directory index |
| `knowledge/product/orchestration/organization-discovery-reports.md` | machine-readable organization discovery report index |
| `knowledge/product/governance/organization-team-template-catalogs/README.md` | organization-specific team template overlay guide |
| `knowledge/product/schemas/organization-profile-report.schema.json` | organization profile JSON output contract |
| `knowledge/product/schemas/organization-catalog-report.schema.json` | organization catalog JSON output contract |
| `knowledge/product/schemas/organization-profiles-report.schema.json` | organization profiles inventory JSON output contract |
| `knowledge/product/architecture/kyberion-concept-map.md` | layer mapping and concept placement |
| `docs/INTENT_LOOP_CONCEPT.md` | non-replaceable intent-loop closure model |
| `knowledge/product/orchestration/guided-coordination-protocol.md` | shared repeated-work coordination flow |
| `knowledge/product/schemas/guided-coordination-brief.schema.json` | shared intake brief for repeated coordination |
| `knowledge/product/architecture/sdlc-gating-model.md` | gate-driven lifecycle governance model |
| `knowledge/product/architecture/ai-agent-track-patterns.md` | AI agent業務のTrack/Gateパターンカタログ（8プロファイル・3パターン） |
| `knowledge/product/architecture/actuator-external-dependency-pattern.md` | 外部依存 Actuator の Provision→Verify→Bind→Run パターン（Service/Voice/Meeting 共通） |
| `knowledge/product/voice/meeting-voice-proxy-setup.md` | Google Meet クローン音声代理プロキシのセットアップ手順 |

## 6. Reading Order

For onboarding and implementation alignment, read in this order:

1. `docs/USER_EXPERIENCE_CONTRACT.md`
2. `docs/INTENT_LOOP_CONCEPT.md`
3. `knowledge/product/architecture/organization-work-loop.md`
4. `knowledge/product/architecture/organization-profile-model.md`
5. `knowledge/product/architecture/mission-team-composition-model.md`
6. `knowledge/product/orchestration/organization-selection-guide.md`
7. `knowledge/product/governance/organization-team-template-catalogs/README.md`
8. `knowledge/product/architecture/enterprise-operating-kernel.md`
9. `knowledge/product/orchestration/README.md`
10. `knowledge/product/orchestration/organization-discovery-reports.md`
11. `knowledge/product/architecture/kyberion-concept-map.md`
12. `knowledge/product/schemas/organization-profile-report.schema.json`
13. `knowledge/product/schemas/organization-catalog-report.schema.json`
14. `knowledge/product/schemas/organization-profiles-report.schema.json`

## 7. Implementation Rule

When a new feature is added, the implementation is concept-aligned only if:

1. It maps to one of the seven internal primitives.
2. It preserves the Request/Plan/State/Result user contract.
3. It can be explained in terms of the six-stage canonical loop.
