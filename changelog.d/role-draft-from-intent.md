---
category: Added
---

- **Draft a role from one sentence** — `pnpm organization role draft --from-intent "<sentence>" [--json]` asks the reasoning backend for a role draft whose every capability, scope class, actuator, tier and team role is checked against the governed inventory. Unknown ids are dropped and listed, invalid choices fall back to the domain defaults, and a description that just repeats the sentence is regenerated once before the draft fails with a classified reason. Nothing is created: the command prints the exact `pnpm organization role create` preview and commit commands. A drafted id never reuses an existing team or authority role id (it is suffixed instead), the output shows the effective grant after the domain template is merged in, and the intent is sent under a confidential egress scope (`--tenant <slug>` when known).
- **Contract design principles** — a short governance note (`knowledge/product/governance/contract-design-principles.md`) on absent vs empty vs zero, failure as a first-class result, and backend opacity.
- **`pnpm organization role create|promote` now print their result** — the facade now passes its printer through, so both commands print their JSON result (previously nothing was printed via `pnpm organization role ...`). `role create` also accepts `--team-role-id <id>` so a non-ASCII `--name` still yields a valid id.
