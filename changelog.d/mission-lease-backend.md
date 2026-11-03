---
category: Changed
---

- **mission-lease → LeaseBackend** — `MissionLeaseManager` persists the live holder through the `lease-backend` seam (mutex + `FencedLeaseRecord`), so shared/memory/local/distributed providers coordinate acquire without changing Mastra-shaped caller semantics.
