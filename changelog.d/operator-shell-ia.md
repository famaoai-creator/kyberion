---
category: Changed
---

- The operator shell has seven destinations: ホーム, あなた待ち, 仕事, 組織, 資料, 運用 and 設定. Old `/w`, `/ops?section=…`, `/ingest` and `/setup` links redirect to them.
- **あなた待ち** (`/inbox`) is the single queue for approvals, customer decisions, deliverable reviews, knowledge candidates, stalled requests and failures.
  - The count has one definition everywhere: the rail badge, Home, the API (`/api/v1/needs-you`) and MCP (`kyberion.needs-you.*`).
  - Duplicate decision panels elsewhere became count-and-link.
- **ホーム** is a glanceable dashboard read from one consistent snapshot. It shows the setup checklist, needs-you by reason, agent states, mission flow, health, key results, cost and recent deliverables, and every tile drills down.
- **設定** is a two-pane panel. It has search, ⌘K entries, an ordered setup checklist with why, time and auto-detected completion, and one place for the reasoning model.
- Mission planning moved to 仕事. Page frame and spacing are consistent, and `/ops` no longer nests a second shell.
- Fixed: browsing `/ops` no longer hits HTTP 429. Read-only requests no longer spend the tenant reasoning budget.
