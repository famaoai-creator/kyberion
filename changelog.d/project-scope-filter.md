---
category: Added
---

- Concierge rail: a project selector under the company card narrows ホーム, 仕事, あなた待ち and 運用 to one project of the selected company. The choice travels in the URL (`organization_id` + `project_id`), is re-validated server-side and only narrows; missions that record no project appear under すべてのプロジェクト only.
- The あなた待ち badge in the rail now follows the selected project (it sent camelCase scope keys the needs-you API ignored).
- Settings › 責任者憲章 and 招待 drop their per-page company pickers, which could never appear: the server already narrows both lists to the company selected in the rail.
