---
category: Added
---

- **Learning-signal harvest** — recurring failures in runtime logs (misunderstood or failed conversation turns, approval rejections on any channel, failed runs outside missions, ADF repairs, delegations, audit denials, worker events, reasoning failovers, metric errors/latency/cost spikes, reopened defects, runtime health trends, peer/discussion/co-session failures, quarantined content) are now proposed as organization learning candidates (`source_type: runtime_signal`), and tenant-free ones also become knowledge hints that later work retrieves. Baseline runs the harvest automatically; `pnpm kyberion learning harvest [--dry-run] [--json]` runs it by hand. Tenant records are harvested only inside their own tenant.
