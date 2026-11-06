---
category: Changed
---

- Concierge serves the training catalog and the voice selection (`/api/training/catalog`, `/api/voice/selection`) in-process instead of proxying them to presence-studio. Settings no longer fail to load when presence-studio is stopped. Voice selection is read and saved as `sovereign_concierge`, the Concierge personal-profile role (Kyberion server phase 2).
