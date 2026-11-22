---
category: Fixed
---

- **Recency window and sample-key frequency counting in `probeAlertDominance`** — bounded `ops-health-probe` alert-dominance detection to a 24-hour default window (`ALERT_DOMINANCE_WINDOW_MS`) so resolved historical alert bursts age out instead of triggering permanent findings, and fixed `sample_key` selection to report the highest-frequency key rather than the lexicographically largest key.
