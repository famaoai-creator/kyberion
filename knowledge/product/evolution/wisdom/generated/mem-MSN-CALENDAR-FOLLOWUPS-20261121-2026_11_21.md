---
record_id: mem-MSN-CALENDAR-FOLLOWUPS-20261121-2026_11_21
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CALENDAR-FOLLOWUPS-20261121-2026_11_21
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-21T15:28:39.566Z
source_branch: feat/calendar-followups-20261121
source_commit: 4dd4014400817f9633b152aac5e335d3c888dd0e
---

# Cross-process freshness, tenant-local ids, and owner-only provider data in surfaces

Validate caches by store signature (not TTL) when writers are other processes; treat organization ids as tenant-local everywhere ids are keyed or looked up; gate a machine provider login behind installation-owner access and detect a real sign-in from status fields.

## Hint Scope

mission

## Trigger Phrases

- Lessons from MSN-CALENDAR-FOLLOWUPS-20261121:

1. Surfaces are read by one server process but written by CLIs and workers in other processes, so an in-memory invalidate-on-write never reaches the reader. Reuse a cached store read only while its change signature (inode, mtime, ctime, size) is unchanged; take the signature before the read so a racing write forces a re-read next time.
2. Organization ids are unique only within a tenant. Everything that keys or looks them up must include the tenant: the workspace graph node key, lineage resolution, label indexes, React and palette keys, and links (`?tenant=`). Without a tenant hint, an id several tenants share must resolve to nothing, never to whichever tenant comes first. A derived index that drops a bare key for an ambiguous id must still index the children.
3. A machine provider login (gws / m365) is the installation owner personal data: gate any route that uses it with resolveConciergeInstallationAccess(viewer, "read", req) before any provider work, and make the client hide the source only on 403 installation_owner_required (not on passing errors).
4. `gws auth status` exits 0 when signed out: "connected" must come from stored credentials or a token cache, and the synchronous status probe should be cached briefly.
5. The service engine loads a personal connection document for CLI presets, which the concierge role may not read (knowledge/personal/connections/). Do not widen concierge allow_read; the governed path is the owner personal-credential admission or an explicit CLI-session auth mode.
6. Next.js App Router route files may only export route members; put helpers and test seams in a lib module.

## Recommended References

- active/missions/public/MSN-CALENDAR-FOLLOWUPS-20261121/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CALENDAR-FOLLOWUPS-20261121/evidence/test-report.md

## Evidence

- active/missions/public/MSN-CALENDAR-FOLLOWUPS-20261121/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-CALENDAR-FOLLOWUPS-20261121/evidence/test-report.md

## Artifacts
