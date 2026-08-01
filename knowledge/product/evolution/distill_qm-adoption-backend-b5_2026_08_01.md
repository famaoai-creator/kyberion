---
title: 'Audience-floor egress enforcement hardened through adversarial review'
category: Evolution
tags: ['development', 'egress-policy', 'TypeScript', 'audience-authorization', 'customer-delivery']
importance: 6
source_mission: QM-ADOPTION-BACKEND-B5
author: Kyberion Wisdom Distiller
last_updated: 2026-08-01
---

# Audience-floor egress enforcement hardened through adversarial review

## Summary

Implemented audience-floor composition using allow-intersection and deny-union semantics, then enforced it at customer egress so bodies containing links outside the tenant-and-operator floor are rejected. Three adversarial review rounds exposed and resolved five security and lifecycle defects, with 18 tests passing at verification.

## Key Learnings

- Effective egress authorization should intersect every applicable allow set while unioning every deny set; this prevents one permissive policy from weakening stricter tenant or operator constraints.
- Audience validation must occur at the final customer-delivery boundary and cover embedded links in the body, because upstream checks alone can be bypassed or dropped during loading and transformation.
- Secure defaults and initialization order are part of the authorization model: a correct policy can still deny all legitimate use or retain stale state if installation and reset behavior are not tested.

## Patterns Discovered

- Compose a tenant-plus-operator audience floor once, then evaluate every outbound customer artifact against that floor at the egress boundary.
- Use multi-round adversarial review to probe identity-derived bypasses, default-install behavior, persistence across load boundaries, opt-in deny composition, and reset ordering before granting approval.
- Pair policy-composition tests with boundary-integration tests so both set algebra and the actual delivery path are verified.

## Failures & Recoveries

- Userinfo-derived identity could bypass audience restrictions → normalized enforcement around the composed audience floor.
- Default installation could brick customer delivery → corrected secure defaults so valid configured traffic remains usable.
- Audience constraints could disappear at the load boundary → preserved policy state through loading before egress evaluation.
- Deny-union behavior was incorrectly opt-in → made applicable denies cumulative by default.
- Reset ordering could leave inconsistent or stale policy state → fixed lifecycle ordering and covered it in the adversarial test suite.

## Reusable Artifacts

- composeAudienceFloor implementation for allow-intersection and deny-union policy composition.
- evaluateAudienceEgress enforcement in the egress-policy layer.
- Customer sendToCustomer guard that rejects body links outside the tenant-and-operator audience floor.
- 18-test regression suite covering composition, bypass, installation, loading, denial, reset, and customer-egress behavior.

---

_Distilled by Kyberion | Mission: QM-ADOPTION-BACKEND-B5 | 2026-08-01_
