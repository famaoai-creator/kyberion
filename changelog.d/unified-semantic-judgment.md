---
category: Added
---

- **Unified System-1 judgment backends (`gemini-decision`, `openai-decision`)** — Added `DecisionBackendAdapter` with managed secret loading, egress/tier enforcement, prompt-injection framing, and provider health-demotion failover across `KYBERION_JUDGMENT_PROVIDERS`.
- **Live `semantic_judgment` production adapters and `semantic-decide` System-1 fast path** — Added `semantic-judgment-live-provider`, `semantic-judgment-decision-ports`, Dot semantic judgment loop (`dot-semantic-loop` / `dot-semantic-budget`), and `semantic-decide` System-1 routing with automatic fallback to `llm_decide`.
- **Judgment calibration runner and unified architecture guide** — Added `scripts/eval/run_judgment_calibration.ts` (`error-corpus` and `routing` suites) and documented the full Work-Loop placement map in `knowledge/product/architecture/judgment-backend-seam.md`.
