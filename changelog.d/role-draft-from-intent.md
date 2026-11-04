---
category: Added
---

- **Draft a role from one sentence** — `pnpm organization role draft --from-intent "<sentence>" [--json]` asks the reasoning backend for a role draft whose every capability, scope class, actuator, tier and team role is checked against the governed inventory. Unknown ids are dropped and listed, invalid choices fall back to the domain defaults, and a description that just repeats the sentence is regenerated once before the draft fails with a classified reason. Nothing is created: the command prints the exact `pnpm organization role create` preview and commit commands. `pnpm organization role ...` now also prints its output through the facade.
- **Contract design principles** — a short governance note (`knowledge/product/governance/contract-design-principles.md`) on absent vs empty vs zero, failure as a first-class result, and backend opacity.
