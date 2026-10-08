---
category: Security
---

- **Codex / Gemini distillation runners without write access** — the `codex-cli` and `gemini-cli` structured runners used by `mission distill` and other `mission-llm` callers no longer run with write access from the repository root. Codex now runs `--sandbox read-only` (it was `workspace-write`) with the prompt on stdin. Gemini now runs `--sandbox --approval-mode plan` (it was `-y`/yolo), and its prompt moved from argv to stdin. Both start in the empty scratch directory `active/shared/tmp/system/mission-llm/cwd`. On a host without a Gemini sandbox runtime (Docker, Podman or macOS Seatbelt), the Gemini runner now fails, and `mission-llm` moves on to the next profile. Other callers of `runCodexCliQuery` / `runGeminiCliQuery` keep their previous behaviour.
