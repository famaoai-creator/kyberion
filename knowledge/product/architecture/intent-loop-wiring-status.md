---
title: "Intent-Loop Wiring Status (connection audit)"
category: Architecture
tags: [architecture, intent-loop, wiring, feedback-loop, audit]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-25
---

# Intent-Loop Wiring Status

Connection audit of Kyberion's core loop (capture intent → goal → execute → review/learn). Records which **seams actually connect at runtime** vs. which are documented-but-unwired, so future work doesn't re-derive this. Verified by reading real call sites (file:line).

## Loop seams — closed (✓) / open (✗)

| Seam | Status | Evidence |
|---|---|---|
| Surface → mission (Slack/Chronos) | ✓ | `surface-mission-proposals.ts:175` shells `mission_controller start` |
| Intent drift gate at mission stages | ✓ **enforced** | `mission-orchestration-worker.ts:55,87` `emitIntentSnapshot`; `mission-lifecycle.ts:229-231` **blocks delivery on blocking drift** |
| Governance (tier-guard / approval / audit / trace→Chronos) | ✓ | tier checks on every `secure-io` write; `enforceApprovalGate` on ≥4 paths; audit JSONL + trace feed read by Chronos |
| Execution → feedback hints (write) | ✓ | `run_pipeline.ts:779,847` → `runFeedbackLoop` persists trace hints to `active/shared/runtime/feedback-loop/hints/` |
| **Feedback hints → resolution (read-back, ④→①)** | ✓ **(fixed 2026-06-25)** | `knowledge-index.ts _scanProductTier` now ingests the feedback-loop hints dir → resurface via `queryKnowledge` |
| **`wisdom:distill` op (⑤→⑥)** | ✓ **(fixed 2026-06-25)** | `decision-ops.ts` `case 'distill'` sources recent `listDistillCandidateRecords()` (deduped) → `memory-distillation.json` now writes HINTS.md |
| **Mission distill → promotion queue** | ✓ **(fixed 2026-06-25)** | `mission-distill.ts` auto-calls `enqueueMemoryPromotionCandidate` on completion |
| Intent resolution (single entry) | ✗ **fragmented** | ≥4 resolvers: `intent-resolution.ts:470` (spine), `procedure-registry.ts:179` (browser/CLI), `intent-track-resolver.ts:301` (CLI-flag-only), `src/intent-compiler.ts:34`. `run_intent.ts` runs two that can disagree |
| "Deterministic-first" ladder (pipelines→actuators→ADF) | ✗ not enforced | No runtime code checks for an existing pipeline before LLM compilation |
| Capability broker (provider selection) | ✗ orphaned | `capability-broker.ts:153 resolveProviderDecision` has no execution call site |
| Surface UX contract | ⚠ tested, not invoked | `surface-ux-contract.ts validateSurfaceUxContract` + test exist, but **no call site** outside the barrel — outbound surface messages are not validated |
| Surfaces → mission (non-Slack) | ✗ silo | Browser extension / iMessage / Telegram don't create missions; receipts use synthetic IDs |

## What the 2026-06-25 fix closed (the "learning loop")

The keystone gap was the **feedback arc ④→①**: traces produced hints but nothing read them back, `wisdom:distill` had no handler (pipeline inert), and `distillMission` never enqueued promotion. All three are now wired (see ✓-fixed rows). The loop's forward path was already sound; the return path is now connected and e2e-verified (memory-distillation pipeline produces deduped lessons into HINTS.md).

## Highest-leverage gaps (status after 2026-06-25 gap-fill)

1. **Resolver convergence** — ✅ done. `chooseExecutionIntent` (`intent-resolution.ts`) makes `run_intent` execute off the canonical resolver's confident decision (exact-ID match), ending the double-resolution divergence. Non-destructive (no resolver deleted). NOTE: a *full* unification (routing `procedure-registry` / `intent-track-resolver` through one entry too) is still future work; this closed the active divergence.
2. **Capability broker wired** — ✅ done. `consultCapabilityBrokerForMode` (`reasoning-bootstrap.ts`) records the reasoning decision to audit + honors a per-mission pin; conservative (no override without a pin, skipped in stub). The deterministic-first **ladder is intentionally NOT code-enforced**: Kyberion's CLI is invoked *by* an LLM agent, so "pipelines-before-LLM" is an agent-discipline rule (CLAUDE.md §2 Default), not a runtime gate. A CLI-side gate cannot bind the orchestrating LLM and is the wrong frame; the lever is pipeline *discoverability*, not enforcement.
3. **UX contract invoked** — ✅ done. `validateSurfaceUxContract` runs at the single outbound chokepoint `runSurfaceMessageConversation` (non-blocking; logs + attaches `uxContract`).
4. **Mission-bind surfaces** — browser ✅ via option C: `handleSubmitReceipt` routes browser executions into the audit chain + distill-candidate registry (Chronos-visible, memory-loop-fed) with **zero mission-store churn**. Telegram hardcoded-user bug fixed (config-driven `TELEGRAM_ALLOWED_USER_IDS`, default-deny). Self-repair deltas now audit-visible (`handleSaveProcedureDelta` records to the audit chain). **iMessage/Telegram mission-binding is DEFERRED by design**: it requires granting NEW governance authority roles (`SurfaceProposalRole` is `'slack_bridge' | 'chronos_gateway'` only) with mission-start power to surfaces that are currently broken (no `imsg` binary; Telegram needs a token) and unverifiable here — a least-privilege/security decision for the architect, not a safe autonomous wiring.

## Still open / future (with rationale)
- **Full resolver unification** (#1 remainder) — DEFERRED: the 4 resolvers serve *different layers* (intent classification vs intent→procedure vs intent→track), not duplicates; the active divergence is already fixed. Forcing one entry is a risky multi-layer refactor of questionable value.
- **Deterministic-first ladder** (#2) — NOT a code task (agent-discipline; see above).
- **Satellite mission-binding** (#4) — needs new authority roles + working surfaces; architect's security call.
- **Bespoke Chronos panel** — SUPERSEDED: browser receipts + repair deltas now flow to the audit feed Chronos already surfaces; a dedicated view is unverifiable Next.js polish (no typecheck script; `next build` only).

## Reasoning backend — "self-as-subagent" wiring (2026-06-25)

Kyberion runs *via* an LLM CLI, so it should be able to **reason as its own sub-agent** instead of always spawning a fresh CLI/API process. That mechanism exists in two forms:

- **`claude-agent` (production)** — `claude-agent-reasoning-backend.ts` + `claude-agent-query.ts` use `@anthropic-ai/claude-agent-sdk` `query()`. **Inherits the parent session's auth when inside a Claude Code harness** (no API key, no new login); falls back to `ANTHROPIC_API_KEY` otherwise. This is the canonical self-subagent path.
- **In-session A2A delegation (`InSessionDispatcher`, prototype)** — was `InSessionReasoningBackend`; **refactored 2026-06-25** out of the reasoning layer into the agent-runtime dispatch plane (`agent-dispatch.ts`). It was never a reasoning backend; its only real job is *dispatch* — ask the base backend (tool-use) which sub-agent to invoke, then route over `a2aBridge.route()` in-process, no spawn. **Option-2 (finish the prototype) still deferred**: `claude-agent` already covers in-session-no-spawn inside Claude Code; the dispatcher's incremental value is narrow (same-process A2A to manifest-bearing Kyberion agents). Keep as experiment, now in its correct home.

### Reasoning vs dispatch separation (refactor 2026-06-25)

"How one agent thinks" (`ReasoningBackend`: `extract*`/`decompose*`/`diverge*`/`prompt`) is now separated from "how a task is handed to a sub-agent" (agent-runtime **dispatch**). `agent-dispatch.ts` defines `AgentDispatcher` with `ProcessSpawnDispatcher` (default — spawn CLI/SDK child via the backend's native `delegateTask`) and `InSessionDispatcher` (in-process A2A). `delegateTask` stays on the `ReasoningBackend` interface, but a strategy can plug in via the `DispatchingReasoningBackend` decorator without masquerading as a full backend. `reasoning-bootstrap.ts` selects the strategy through `maybeWrapWithDispatcher(backend)` (`KYBERION_IN_SESSION_SUBAGENT=1` → in-session; default returns the backend unchanged). The decorator forwards cognition to the base, fixing the latent failure where enabling in-session mode made structured cognition paths throw. Tests: `agent-dispatch.test.ts`.

**Host detection (the fix).** Before this, `claude-agent` was never auto-selected — inside Claude Code the resolver fell through to the `codex-cli` default (spawning an external CLI). Added a last-priority rule so a Claude Code harness prefers the in-session sub-agent:
- `reasoning-backend-policy.json` + `FALLBACK_POLICY` (`reasoning-backend-policy.ts:82-85`): `auto_select_env_priority` ends with `{ env: 'CLAUDECODE', mode: 'claude-agent' }`. **Placed last** so explicit API-key signals (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, nemotron/local/openrouter) and `KYBERION_REASONING_BACKEND` / `requestedMode` all still win.
- `reasoning-bootstrap.ts` install branch hardened: `claude-agent` registers only when `CLAUDECODE || ANTHROPIC_API_KEY || force`, else falls back to stub (avoids registering a backend that would fail at delegate time).
- Note: the CLAUDECODE rule lives in `auto_select_env_priority`, **not** `cli_preference_rules` — the latter require a HEALTHY provider snapshot (`reasoning-backend-policy.ts:195`), so a provider-less host rule would never fire there.

**Runtime-confirmed live (not just unit-tested), this session:**
- `resolveReasoningBackendModeFromContext({ env: process.env })` → `claude-agent` (CLAUDECODE set, all higher-priority env unset).
- `installReasoningBackends()` → `true`; `getInstalledReasoningMode()` / `getReasoningBackend().name` → `claude-agent`; bootstrap logs `mode=claude-agent — @anthropic-ai/claude-agent-sdk sub-agent delegation (model=opus)`. This is the same install path `run_pipeline`/`delegateTask` use, so reasoning delegation routes through the in-session sub-agent here — no CLI spawn.
- Control: `resolveReasoningBackendModeFromContext({ env: {}, providers: [] })` → `codex-cli`, proving selection is driven by the rule, not the ambient env.

Tests: `reasoning-backend-policy.test.ts` "prefers the in-session claude-agent … (CLAUDECODE)" (4 assertions incl. API-key-wins + requestedMode-wins + no-CLAUDECODE-default). Known unrelated failure: `reasoning-bootstrap.test.ts` "auto-selects codex-cli" — `codex` CLI not installed on this machine (env-gated), independent of this change.

### Backend structured-reasoning parity (2026-06-25)

Audit of `not implemented` in code found two selectable reasoning backends — `openai-compatible-backend.ts` (`local` mode) and `openrouter-backend.ts` (`openrouter` mode) — that implemented `prompt`/`delegateTask`/`generateWithTools` but threw on all 9 structured ops (`divergePersonas`/`crossCritique`/`synthesizePersona`/`forkBranches`/`simulateBranches`/`extractRequirements`/`extractDesignSpec`/`extractTestPlan`/`decomposeIntoTasks`). Selecting either mode and running the requirements-to-design-to-tasks pipeline or `wisdom:*` divergence ops would crash.

**Fixed** by extracting the contract into `structured-reasoning.ts`: shared system prompt, Zod schemas, 9 `StructuredOpSpec`s, tolerant JSON parsing, and `runStructuredReasoningOp`. `openai-compatible-backend.ts` and `openrouter-backend.ts` now implement the 9 ops via toolless structured completions. `codex-cli-reasoning-backend.ts` now sources the same shared specs instead of carrying a private copy. Tests: `structured-reasoning.test.ts` and `codex-cli-reasoning-backend.test.ts`.

Other `not implemented` markers are intentional/deferred, not this bug class: planned substrate adapters, denied ACP host capabilities, and scaffolder templates.

### Claude Code ↔ Kyberion integration — Direction A (front-end), 2026-06-26

Integration was tool-level (MCP) plus soft-prompt. The stronger integration point is governance at the tool lifecycle via hooks. Added a Claude Code plugin under `plugins/kyberion-claude-code/` with plugin manifest, hooks, MCP config, and commands.

Hook logic lives in `libs/core/claude-code-hook.ts`, with `scripts/claude_code_hook.ts` as the stdin/stdout CLI:
- **PreToolUse** gates protected-tier writes (`personal`/`confidential`) through `validateWritePermission`; public/source/tmp paths pass.
- **PostToolUse** records Claude-Code-initiated tool activity into the audit chain.
- **SessionStart** injects the operating guide and governance reminder as additional context.
- Commands: `/ky-baseline`, `/ky-mission-start`, `/ky-review`.

`@agent/core` exports now include `./claude-code-hook` and `./claude-code-hook.js`. Tests: `claude-code-hook.test.ts`. Deferred: `UserPromptSubmit` intent capture, `Stop` auto-distill, and Bash-level secure-io screening.

### Claude Code ↔ Kyberion integration — Direction B (backend), 2026-06-26

The `claude-agent` backend kept `delegateTask` on a pure one-shot path, so delegation was not agentic. Added an opt-in governed agentic path so the SDK sub-agent acts as a Kyberion citizen rather than a raw Claude Code instance.

- `libs/core/claude-agent-governance.ts` adds `createKyberionCanUseTool()`, reusing Direction A's `evaluatePreToolUse` for file-write tier checks; read-only and `kyberion.*` MCP tools pass, Bash is allowed/audited, unknown tools are denied.
- `buildKyberionMcpServerConfig()` wires Kyberion's MCP surface into the sub-agent, and `buildGovernedAgentSystemPrompt()` injects deterministic-first, tier, mission, and knowledge context.
- `claude-agent-query.ts` adds `runClaudeAgentTask()` for multi-turn, tools-enabled task execution.
- `claude-agent-reasoning-backend.ts` routes `delegateTask` through the governed path only when `KYBERION_CLAUDE_AGENT_TOOLS=1`; structured `extract*` ops stay pure.

Tests: `claude-agent-governance.test.ts`. The live SDK agentic loop remains opt-in because it needs the SDK/runtime, but governance logic and wiring are verified.

### Improvement loop — consumption side closed (2026-06-29)

The learning loop's *capture* arc (④ execution → `runFeedbackLoop` → `runtime/feedback-loop/hints` → `knowledge-index` ingest; plus distill-candidates → `wisdom:distill` → promotion) was wired, but the *consumption* arc was open: `queryKnowledge` had only two callers (`knowledge-index` itself + the `kyberion.knowledge.search` MCP tool), so accumulated lessons reached the next run **only if the LLM agent chose to search** — the resolver never consulted knowledge, so improvement was opportunistic (pull), not guaranteed.

**Closed** by `gatherImprovementHints(intent)` (`intent-resolution.ts`): builds the knowledge index and `queryKnowledgeHybrid`-queries it for the intent, returning the top lessons. `run_intent.ts` calls it right before `resolveAndExecuteIntent` and injects the hits as `knowledge_hints` on the execution context — so past learning (feedback-loop hints + promoted memory) now biases every intent execution by default. Best-effort and non-blocking (any knowledge-subsystem failure → `[]`, execution proceeds); dynamic import avoids a load-time cycle. Verified end-to-end: against the real index `gatherImprovementHints('deploy web app pipeline')` returns 5 ingested hints (no throw); empty intent skips the index. Tests: `intent-resolution-improvement-hints.test.ts`. The forward path (intent→task→actuator), capture, and now consumption all connect — the loop turns without relying on agent discretion.

### Completion telemetry — agent/model token + cost (2026-06-29)

`MetricsCollector` (`metrics.ts`) already aggregated per-component tokens + cost (per-model `COST_TABLE`, persisted to `work/metrics/execution-metrics.jsonl`, `reportFromHistory()`), fed by orchestrator / skill-wrapper / agent-lifecycle (ACP usage) / vision-judge. Two surfaces were not feeding it — now wired:
- **`claude-agent` reasoning sub-agent**: `claude-agent-query.ts` extracts `usage` (input+cache-creation / output tokens) from the SDK result and calls `metrics.record('reasoning:claude-agent' | 'reasoning:claude-agent-task', …, { model, usage })` for both the one-shot and agentic paths (best-effort).
- **Front CLI (Claude Code)**: the plugin's `Stop` hook reads `transcript_path` (raw fs at the script boundary — an external CC artifact outside secure-io's project-root guard), `summarizeTranscriptUsage` sums per-turn usage, and `recordCliUsage` records it under component `claude-code-cli`. The metrics *write* stays governed (secure-io via the collector).
- **Model pricing is now data, not code**: rates moved out of the hardcoded `COST_TABLE` into the knowledge-tier registry `knowledge/product/governance/model-cost-registry.json` (per-1k prompt/completion + `aliases` + `default`), loaded at runtime by `loadModelCostRegistry()` (secure-io read, cached, built-in fallback). `resolveCostRates(model)` resolves exact id → alias → longest substring (so versioned ids `claude-opus-4-8-…` / `gemini-2.0-flash-exp` and SDK aliases `opus`/`sonnet`/`haiku` map to family rates) → `default`. **New models / repricing need only a JSON edit — no source change or redeploy.**

Verified end-to-end: recording an opus usage entry persists `cost_usd` correctly ($0.0525 for 1000/500 tok); and adding a model to the JSON is picked up by a fresh process with no rebuild. Tests: `claude-code-hook-usage.test.ts`, `metrics-cost.test.ts` (incl. a load-from-file assertion). So "on completion, which agent/model spent how many tokens/$" is now collected for reasoning sub-agents and the front CLI (not just ACP agents), with prices maintained as governance data.

→ Full audit context: this file supersedes ad-hoc findings; re-verify file:line before acting (point-in-time).
