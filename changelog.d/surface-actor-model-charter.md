---
category: Added
---

- **Accountability charter (core)** — `libs/core/governance/accountability-charter*.ts`: a standing declaration of the accountable human, authority envelope and loss appetite. Agents act inside it without per-action approval; anything outside is denied with an amendment proposal. Not yet wired into the approval gate — scopes without a charter behave as before.
- **Concierge is installable** — web app manifest, icons and a minimal service worker (offline notice only; live decision data is never cached). Remote browsers can fetch these without being bounced to `/login`.
- **Quiet hours** — Settings › Notifications › おやすみ時間: non-urgent notifications are parked in the local inbox during the window; operations alerts still get through (configurable). Stored in `notification-preferences.json` (`quiet_hours`, `urgent_events`).
- **Which organization is asking** — approval cards in the decision queue now show the organization the request belongs to.
