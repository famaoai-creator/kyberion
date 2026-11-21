---
record_id: mem-MSN-CALENDAR-SOURCES-20261121-2026_11_21
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-CALENDAR-SOURCES-20261121-2026_11_21
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-21T13:50:16.374Z
source_branch: feat/work-calendar-sources-20261121
source_commit: 72ac3fdc54300397bf8802e94d1fa931ddaa85a9
---

# Reading child records across scopes for a surface view

Inherit visibility from the viewer-filtered workspace graph, open one store grant per request, judge periods at the local period end, and treat org-level records as out of scope for project-scoped viewers.

## Hint Scope

mission

## Trigger Phrases

- Lessons from workspace.calendar (MSN-CALENDAR-SOURCES-20261121), which joins work items, organization operations and meeting action items:

1. Inherit, do not re-derive, visibility: read a child store (operations, action items) only for a parent node already present in filterWorkspaceGraph(graph, viewer). Then no store of a hidden scope is ever opened, and a short module cache keyed by store scope cannot leak across viewers.
2. Node admission is not record access: scopeContains admits a node that lacks a dimension, so a project-scoped viewer is admitted to its organization node. Organization-level records (operations) belong to no project; do not return them to a project-scoped viewer, and take only missions whose projectId is in the viewer projects.
3. withStoreGrant(workspace_graph_reader) is a disclosure grant: every opening appends an audit record. Open it once per request around all reads (a withReads seam), cache reads briefly, skip archived parents, and turn a grant failure into degraded rather than failing the whole view.
4. Period judgements: organizationOperationDeadlineProjection reads the period from the instant local date. To judge a past month, pass its last local day 23:59 via zonedWallTimeToInstant in the trigger zone; 12:00 UTC on the last day is already next month east of UTC+12.
5. Keep start and due days separate in a date API; collapsing them into one date turns start-only items into overdue ones. For timed records send the instant (dueAt) and let the client take its local day; widen the server range by a day for them and filter summaries to the visible grid.
6. A new surface operation needs its ceremonies: the operation-id list test, the MCP facade tool list test, and an mcp-tool-catalog.json entry.

## Recommended References

- active/missions/public/MSN-CALENDAR-SOURCES-20261121/evidence/implementation-report.md
- active/missions/public/MSN-CALENDAR-SOURCES-20261121/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-CALENDAR-SOURCES-20261121/evidence/implementation-report.md
- active/missions/public/MSN-CALENDAR-SOURCES-20261121/evidence/REVIEW-execution-implement.md

## Artifacts
