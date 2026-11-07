---
category: Changed
---

- 進み具合 is now the 依頼 (requests) tab of Concierge 仕事 (`/work?tab=requests`) instead of a presence-studio page (Kyberion server phase 2). Links that pointed at it (the secretary, 使い方, the work-inventory hearing, Studio home) now say 依頼 too.
  - It lists your requests: open ones with their recorded state, latest recorded update and a phase estimate (labelled as an estimate, not a measurement), then delivered and finished ones. Choosing one shows its detail and timeline; `?request=<id>` opens it directly, and the secretary's request links land there. It follows the header's company choice, including the personal and company-less views.
  - Deliveries get a readable title (a date-named file shows as its kind and date) and their kind as a label. Personal-tier deliveries, and deliveries whose tier nothing states, are never shown, by the same rule as 成果物.
  - Deliverable decisions are no longer made on this page: a delivered item shows its 受信箱 status and, while a decision is waiting and you can open 受信箱, links to its deliverable reviews. Files of a delivery open through Concierge's outcome files.
  - 業務の自動化候補 (automation candidates from your work inventory, with your own recording-consent line) moves into the same tab, served by `GET /api/work-inventory/candidates` for the selected company.
  - The read model moves to `@agent/core/surface/front-desk-progress`, shared with presence-studio, which keeps `GET /api/progress` for its 頼む page. Concierge serves `GET /api/progress` and `GET /api/progress/[id]`, scoped to the viewer server-side; another company's request is never listed or returned.
  - The old Studio address `/progress` (and `/progress.html`) redirects to Concierge with its query kept. Removed from Studio: the progress page, `/api/progress/:id`, `/api/progress-vocabulary`, `POST /api/outcomes/:id/verdict`, `/api/front-desk/work-inventory`, `/api/work-inventory-vocabulary`, and the 頼む page's correction hand-off (`/ask?correction=`, `GET /api/progress/:artifactId/correction-context`), which nothing links to any more.
