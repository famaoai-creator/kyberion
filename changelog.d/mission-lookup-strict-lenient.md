---
category: Changed
---

- **Mission lookup has an explicit strict / lenient contract** — `pathResolver.findMissionPath` stays the strict lookup (an id in several tenants or a mission directory this process may not see throws `OWNER_AMBIGUOUS` / `OWNER_NOT_VISIBLE`), and `tests/mission-lookup-boundary.test.ts` now pins every direct caller to a reason (lifecycle, scope-derivation, placement) so a new caller must choose consciously. Paths where "absent" is a conservative no-op (identity resolution, the NHI orphan report, the optional visual-review evidence write) use the new `missionPathOrNull(findMissionPath, id)` (`@agent/core/mission-lookup`), which treats an ambiguous or hidden mission as absent.
