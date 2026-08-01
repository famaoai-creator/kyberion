---
title: 'Secure Plugin-Pack Adoption with Backend Session Reset'
category: Evolution
tags: ['development', 'plugin-adoption', 'TypeScript', 'ACP']
importance: 6
source_mission: QM-ADOPTION-PACKS-B6
author: Kyberion Wisdom Distiller
last_updated: 2026-08-01
---

# Secure Plugin-Pack Adoption with Backend Session Reset

## Summary

Implemented governed plugin-pack import with HTTPS-only sources, collision protection, archival, fingerprint checks, provenance-based approval, and import records. Added session reset support for Copilot ACP and Codex app-server backends, with all 47 tests passing after adversarial review.

## Key Learnings

- External pack adoption should combine transport restrictions, immutable fingerprints, collision-safe identifiers, archival behavior, and existing provenance gates rather than relying on a single trust check.
- Backend lifecycle capabilities such as session reset must be implemented by each backend and forwarded consistently through wrappers to preserve interface behavior.

## Patterns Discovered

- A two-round adversarial review is effective for import features because pack poisoning, slug collisions, and root-layout identifier conflicts can evade ordinary happy-path testing.
- Potentially unsafe imports can remain usable by recording them as pending approval through the established provenance workflow instead of creating a separate authorization path.

## Failures & Recoveries

- Adversarial review exposed pack-poisoning, slug-collision, and root-layout identifier risks → HTTPS-only import, fingerprint guards, collision skipping, archival semantics, and provenance gating were added before verification closed at GO.

## Reusable Artifacts

- plugin-pack.ts secure pack-import implementation and CLI --pack integration
- ImportRecords and provenance-gated pending_approval workflow
- resetSession implementations for Copilot ACP and Codex app-server backends with wrapper forwarding
- 47 passing tests covering plugin-pack and backend-session behavior

---

_Distilled by Kyberion | Mission: QM-ADOPTION-PACKS-B6 | 2026-08-01_
