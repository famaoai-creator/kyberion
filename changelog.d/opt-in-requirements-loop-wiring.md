---
category: Added
---

- **Opt-in strict alignment brief framing** — Added optional `requirementsGovernance` controls (`strictFraming`, `changeLevelRouting`, `requireUncertaintyFallback`, `assumptions`, `maturityLevel`) to `mission-brief.schema.json` plus `--strict-framing` and the `brief_incomplete` verdict on `mission_alignment_request` / `mission_alignment_decision`. Default legacy behavior stays unchanged unless opted in.
- **Opt-in L1/L2/L3 review re-entry routing** — Added `classifyReviewReentryChangeLevel` and opt-in change-level re-entry routing (`requirements_change_level_routing` / `requirementsGovernance.changeLevelRouting`) in `finishMission` and `reenterMissionFromReview` so `wrong_direction` pauses for alignment re-approval, `scope` updates specifications before implementation, and quality/content fixes remain bounded.
- **Opt-in ADF uncertainty fallback guardrail** — Added `uncertainty.require_llm_decide_fallback` in `adf-execution-policy.json` and `AdfGuardrailOptions.strictUncertaintyContract` to promote `llm-decide-without-fallback` from warning to blocking preflight error so `runAdfLifecycle` triggers `autoRepair`.
- **Compact worker OOD escalation & strategist framing** — Refined `CORE_WORKING_PRINCIPLES[0]` and `ROLE_WORKING_PRINCIPLES.product_strategist` (`planner` alias included) to surface out-of-distribution premises and scope boundaries via `gaps`/`needs` or `customer_decisions`.
