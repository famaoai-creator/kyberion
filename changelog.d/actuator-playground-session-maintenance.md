---
category: Added
---

- **Playground session maintenance** — `--sessions` lists recorded sessions, `--show <name>` prints a session's steps, and `--record <name> --drop-last` removes the last step (combined with `--actuator`/`--op` it drops the previous step and records the new run in its place, only on success — a failed replacement never loses the recorded original).
