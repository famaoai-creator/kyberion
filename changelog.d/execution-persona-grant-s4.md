---
category: Security
---

- `pnpm mission:compose-team --write` no longer copies the mission's Org Role (or `--persona`) into `KYBERION_PERSONA`. An Org Role value that matched a persona name such as `sovereign` could raise the team-plan writer's authority; the writer now runs with the caller's own identity (concept model v2 D5, S4).
