---
record_id: mem-MSN-SEARCH-MAPS-READ-20261122-2026_11_22
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-SEARCH-MAPS-READ-20261122-2026_11_22
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-11-22T01:43:11.112Z
source_branch: fix/declare-search-maps-reads-20261122
source_commit: 80ada5107d3e2ca7934792c6f9ac35b6608518a6
---

# An approved read is checked against its preset templates: declare it only when command, args and tool are literals

When an operator approves making a service approval-free, apply it per operation. Declare risk: read only where the preset's command, args and tool_name hold no caller template, and constrain the payload with payload_template. A caller-chosen resource (sqlite {{db_path}}) or free-form SQL stays gated even inside an approved service.

## Hint Scope

mission

## Trigger Phrases

- - An operator's OK for a service ("Brave, Maps, SQLite") is applied per operation, after checking the preset. MCP stdio routes build command, args and tool_name from the preset alternative, and caller params fill only `{{...}}` templates. An operation whose spawn args or tool are all literals (brave_web_search, maps_geocode) cannot change its resource, so it can be declared read.
- Keep gated anything whose resource or effect comes from the caller: sqlite `query` runs any SQL, and both sqlite operations put `{{db_path}}` in the spawn args (opening a missing file creates it). Report the exclusion to the operator instead of applying the OK blindly.
- Without `payload_template`, an MCP operation passes all caller params to the tool unchecked. Add one that maps only the declared parameters when declaring a read.
- After regenerating service-harness-registry.json, diff it entry by entry, and diff the top-level keys too. Only the intended operations may change.
- Making an MCP operation approval-free also lets an agent start its `npx -y` package. Unpinned packages become an approval-free supply-chain path, so pin them as a follow-up.

## Recommended References

- active/missions/public/MSN-SEARCH-MAPS-READ-20261122/evidence/implementation-report.md
- active/missions/public/MSN-SEARCH-MAPS-READ-20261122/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-SEARCH-MAPS-READ-20261122/evidence/implementation-report.md
- active/missions/public/MSN-SEARCH-MAPS-READ-20261122/evidence/REVIEW-execution-implement.md

## Artifacts
