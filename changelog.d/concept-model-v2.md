---
category: Changed
---

- **Concept Model v2 decided and staged.** A decision record (`knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md`) fixes eight meanings:
  - A WorkItem is the Issue, and steps are child WorkItems that carry the lease.
  - There is one Lease primitive (`libs/core/lease/`).
  - A Tenant contains many Organizations.
  - A Stance is the acting-for selection.
  - Roles split into separate axes, and Execution Persona is deprecated.
  - A Grant is principal × scope × operation.
  - One intent resolver emits a single RoutingDecision.
  - The memory loop is closed and scoped.

  The concept registry gains a `lifecycle` field (`transitioning`, with a decision and a plan, or `deprecated`, with `replaced_by`). The `concept-registry` gate checks it. Six terms were added and nine redefined. GLOSSARY now gives each decided meaning and labels today's behaviour as _transitioning_. Four ordered migration plans are indexed in `improvement-plans-2026-11`.
