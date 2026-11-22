---
category: Changed
---

- **Mailbox delivery is now hinted instead of purely polled.** The extension holds a persistent native port and the bridge host pushes `mailbox_hint` frames when the request files change (~1-2 s pickup, including a session's first step). A heartbeat keeps the service worker warm; the minute alarm poll and the post-activity 5 s fast poll remain as fallbacks, and pull polling is still the transport — hints never carry request bodies.
