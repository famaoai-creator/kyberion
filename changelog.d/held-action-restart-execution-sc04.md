---
category: Added
---

- **Restart-executable held actions (SC-04, part 1)** — held action records now persist their serializable `params` in both the journal and legacy state file, so a process restarted after approval can run the effect once `registerExecutor(op)` rehydrates the executor. Executable closures still never reach disk; effects should reference secrets rather than embed them.
