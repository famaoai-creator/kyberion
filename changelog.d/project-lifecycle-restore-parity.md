---
category: Fixed
---

- **Project lifecycle facade parity** — `pnpm project restore` now returns an archived project to the status recorded at archive time (`metadata.status_before_archive`, falling back to `active`) instead of always reactivating it. Project and track creation and mutation, including `pnpm project create` and `pnpm project bootstrap`, now require the mission owner; worker contexts are rejected. Descriptive `track update` calls no longer reselect the default track — that only happens on status transitions. All `pnpm project` commands now reject unknown or valueless options instead of silently ignoring them.
