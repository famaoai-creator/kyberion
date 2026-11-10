---
category: Fixed
---

- Memory lease backends now reject conflicting synchronous entry while an asynchronous callback owns or is waiting for the same resource. Memory and KV-stub queues recover from callback failures without retaining completed reservations or creating unhandled cleanup rejections.
