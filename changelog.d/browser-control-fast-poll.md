---
category: Changed
---

- **`browser control` steps no longer stall without the side panel.** After any `control_step` is seen, the extension keeps the 5 s mailbox fast poll alive for a 5-minute activity window — each tick's native call is enough MV3 service-worker activity on its own, so interactive `observe → step → step` loops stay responsive with the side panel closed. The first step of a session can still wait for the ~1-minute alarm poll (pull transport has no push path).
