# Kyberion Operating Guide

Rules and lifecycle for AI agents working in this repository.

> **Language**: Operator-facing rules are in English; phase and onboarding docs are authored in Japanese. See [DOCUMENTATION_LOCALIZATION_POLICY.md](./docs/DOCUMENTATION_LOCALIZATION_POLICY.md).
> **First-time setup**: See [docs/INITIALIZATION.md](./docs/INITIALIZATION.md).
> **Canonical file**: `AGENTS.md`. `CLAUDE.md`, `CODEX.md`, and `GEMINI.md` are symlinks — edit here only.

## 1. Rules

These apply in every phase. No exceptions.

1. **All file I/O through `@agent/core/secure-io`.**
   Never use `node:fs` directly. Manage mission lifecycles (start, checkpoint, finish) via `scripts/mission_controller.ts` ([KSMC](./docs/GLOSSARY.md#ksmc-kyberion-sovereign-mission-controller) v2.0). Each mission runs in its own Git repository for atomic rollback.

2. **Use existing Actuators first.**
   Consult [`CAPABILITIES_GUIDE.md`](./CAPABILITIES_GUIDE.md) and `libs/actuators/` before writing custom code for screenshots, API calls, file conversions, etc. Temp files go in `active/shared/tmp/` or mission-local storage, not ad hoc directories.

3. **Strategic Delegation via Subagents.**
   For high-volume or specialized tasks (e.g., bulk refactoring, deep codebase analysis), use `getReasoningBackend().delegateTask()`.
   - **Gemini CLI specific:** When running in `gemini-cli` mode, this method spawns an autonomous sub-agent with YOLO mode enabled, leveraging `generalist` or `codebase_investigator` tools to minimize main-loop context consumption.
   - **ADF Guardrails:** If an ADF file is invalid, use `validateAndRepairAdf` to dispatch a repair sub-agent before proceeding.

4. **Execute only validated [ADF](./docs/GLOSSARY.md#adf-agentic-data-format) contracts.**
   Lifecycle: `draft → preflight (including sub-agent repair if needed) → auto-repair (if safe) → commit → execute`. Prefer semantic briefs and governed compilers over hand-written executable ADF. On failure, classify and repair — never retry a broken contract.

5. **Enforce 3-tier data isolation.**

   `knowledge/personal/` (private), `knowledge/confidential/` (org-internal), `knowledge/public/` (reusable). No leaks from higher to lower tiers. Project-scoped isolation uses `confidential/{project}/`.

6. **One owner per mission.**
   Each mission has exactly one owner agent. Workers collaborate through task contracts — they do not mutate mission-wide state directly.

7. **Create a mission for substantive work — don't bypass the framework.**
   When a user request triggers **any 2 of the 5 conditions** below, start with `mission_controller.ts create` and route the work through a pipeline in `pipelines/` rather than going straight to Write/Edit:

   1. **5+ artifacts** — the output is not a one-shot edit; divergence and cross-critique add value
   2. **External / regulatory audience** — governance, audit trail, and review gates become deliverables
   3. **Re-execution or variant exploration likely** — ADF replayability matters
   4. **Same pattern ≥5 times expected** — knowledge accumulation is load-bearing
   5. **Multiple legitimate viewpoints** — single-view output would degrade quality (strategy, architecture choice, business plan)

   **Dog-food rule:** anything that ships to customers as evidence of Kyberion's own governance (reports, audit trails, architecture decisions sold as differentiators) **must** be produced via the mission/pipeline path — never ad-hoc. Output from `projects/` whose selling point is "Kyberion-backed audit trail" and was not itself produced under a mission is a contradiction.

   **Reasoning backend:** prefer `KYBERION_REASONING_BACKEND=claude-cli` when a local `claude` CLI is authenticated (no API key needed); fall back to `anthropic` with `ANTHROPIC_API_KEY`, or `stub` for offline / deterministic testing. Pipelines with divergent-thinking ops (`wisdom:a2a_fanout`, `wisdom:cross_critique`, etc.) only produce real content with a non-stub backend.

## 2. Lifecycle (5 Phases)

### Session Start Detection

Immediately on session start, run:

`pnpm pipeline --input pipelines/baseline-check.json`

Transition by the `status` field in the report:

| Status | Action |
|---|---|
| `needs_recovery` | → **② Recovery** |
| `needs_onboarding` | → **① Onboarding** |
| `needs_attention` | → **③ Alignment**, but surface the failed layer to the user before proceeding. |
| `all_clear` | → **③ Alignment** |
| `fatal_error` | Pipeline itself failed. Report the error to the user and halt — do not enter any phase until resolved. |

### ① Onboarding
Set up the environment and user identity: `pnpm install` → `pnpm build` → `pnpm surfaces:reconcile` → `pnpm onboard`.
→ [phases/onboarding.md](./knowledge/public/governance/phases/onboarding.md)

### ② Recovery
Resume from interruptions. Restore prior state and continue from the suspension point.
→ [phases/recovery.md](./knowledge/public/governance/phases/recovery.md)

### ③ Alignment
Interpret user intent and define goals. Do not change code until goals are agreed upon.
→ [phases/alignment.md](./knowledge/public/governance/phases/alignment.md)

### ④ Execution
Change one thing at a time, test immediately. If a major obstacle arises, return to ③ to re-align.
The owner controls mission state; workers participate via task contracts.
(See Rule 4 for ADF preflight requirements.)
→ [phases/execution.md](./knowledge/public/governance/phases/execution.md)

### ⑤ Review
Extract learnings from both successes and failures into `knowledge/`. Clean up temp files. Auto-generate hints from execution Traces for future runs (Feedback Loop).
→ [phases/review.md](./knowledge/public/governance/phases/review.md)

## 3. References

| Document | Content |
|---|---|
| [docs/INITIALIZATION.md](./docs/INITIALIZATION.md) | First-time setup walkthrough |
| [docs/GLOSSARY.md](./docs/GLOSSARY.md) | Key terms |
| [docs/COMPONENT_MAP.md](./docs/COMPONENT_MAP.md) | Directory structure |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Quick start |
| [CAPABILITIES_GUIDE.md](./CAPABILITIES_GUIDE.md) | Actuator catalog |
| [docs/OPERATOR_UX_GUIDE.md](./docs/OPERATOR_UX_GUIDE.md) | Daily operations |
| [pipelines/README.md](./pipelines/README.md) | Pipeline catalog |
| [phases/](./knowledge/public/governance/phases/) | Per-phase runbooks |
| [architecture/agent-mission-control-model.md](./knowledge/public/architecture/agent-mission-control-model.md) | Mission control model |
