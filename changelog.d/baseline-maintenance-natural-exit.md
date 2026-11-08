---
category: Fixed
---

- Release the event-loop reference for baseline's detached background janitor after managed registration, so successful baseline and golden checks can exit naturally while maintenance continues. Preserve submission, supervision, logs and failure markers.

- Isolate golden compiler scans from parallel validation gates without changing its checks or timeout. Validate combined gate scheduling before merging runner changes and include per-gate execution timing in reports.
