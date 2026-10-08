---
category: Fixed
---

- **Mission distillation no longer picks a codex profile that cannot run** — the LLM profile probe now checks the codex binary the codex-cli adapter would actually use, so a project-local shim on PATH no longer makes a codex profile look available. Before, `mission distill` tried that profile, logged a spurious `non-quota error`, and dropped to structural distillation without trying any other profile.
