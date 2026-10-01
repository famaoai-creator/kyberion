---
category: Fixed
---

- **PR creation authentication** — the governed PR command now forwards existing GitHub token bindings explicitly to GitHub CLI subprocesses, so cloud-provided authentication works without enabling credential inheritance for other commands.
