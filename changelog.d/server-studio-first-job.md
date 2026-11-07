---
category: Changed
---

- 初めての仕事 (`/first-job`) is now a Concierge page instead of a presence-studio page (Kyberion server phase 2).
  - The rail's 資料・学習 › はじめての仕事 link opens it in Concierge; the old Studio address (and `/first-job.html`) redirects there with the query kept. `pnpm onboarding first-job` now prints the Concierge address.
  - The guide is unchanged: it sends the one fixed diagnostic request, shows its held approvals for you to approve or reject, offers to end a request that can no longer be verified, and shows and compares the delivered receipts.
  - Its API moves to Concierge `/api/first-job*` with the same contracts and Studio's checks kept exactly: a loopback connection, a loopback `Host` (also for reads) and same-origin posts. "The owner of this computer" is now the signed-in installation owner on this computer (or, during first-run setup, the local operator); another signed-in member is refused. Refusals (including Concierge's own rate limit and write guard, which are safe to retry) are shown in the page's own words.
