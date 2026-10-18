---
category: Added
---

- **Evidence-gated lesson contract in mission distillation** — `pnpm mission distill` now emits an optional structured `experience` record (cue / lesson / evidence / confidence) plus per-change attribution rows whose verdicts include `confounded`, and writes them into `evidence/distillation.md`. The memory-promotion queue carries the lesson on the candidate (`distill_experience`, `distill_experience_declined`), `pnpm mission memory-review` prints the lesson and flags declined or low-confidence lessons, and brokered cross-tier promotions warn that free-text lesson fields need the approver's redaction check. Imported from google-research/harness2's experience contract; the distill prompt documents narrow-or-decline semantics so unsupported lessons are omitted instead of promoted.
