---
category: Added
---

- **Organization-scoped deliverables and mission → project promotion** — `writeScopedArtifact` gains an `organization` scope (`active/organizations/<tier>/<tenant|shared>/<org>/artifacts/<class>/`), and an organization can own a published ArtifactRecord. The organization daily digest now files each organization's entry as a published report in that organization's own scope (`persist: true`). When a mission linked to a project finishes, its published `report` / `export` artifacts are copied into the project and their records re-pointed there; the original stays in the mission archive. Chronos `mission-asset` serves organization artifacts with the organization's tier and tenant, and the project view lists a re-registered artifact once.
