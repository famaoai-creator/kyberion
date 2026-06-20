---
title: Token Management RFC Implementation Tasks for GPT-5.4 mini
category: Architecture
tags: [architecture, implementation, token, reasoning, cache, reflex]
importance: 9
author: Ecosystem Architect
last_updated: 2026-06-20
---

# Token Management RFC Implementation Tasks for GPT-5.4 mini

## 1. Purpose

This document turns [`token-management-rfc-2026-06-20.md`](./token-management-rfc-2026-06-20.md) into bounded implementation tasks suitable for GPT-5.4 mini.

Execute one task at a time. Do not combine tasks into one patch. After each task, run its focused tests and stop if they fail.

## 2. RFC Review Result

The RFC direction is compatible with the current architecture, but it is not directly implementable as one change. Four decisions were underspecified:

1. The first-pass reasoning-level rules were not fixed.
2. The telemetry owner and event shape were not fixed.
3. `resolveIntentCompilerTarget()` currently resolves provider/model metadata but `defaultAsk()` calls the already-registered backend without a per-call model target. Therefore model switching cannot be activated safely by changing the intent compiler alone.
4. Reflex promotion thresholds were open, while Kyberion already has a governed promotion queue and ratification workflow.

The implementation order below resolves those gaps without changing stable public extension surfaces.

## 3. Global Constraints

Apply these constraints to every task:

- Follow `AGENTS.md` and use `@agent/core/secure-io` for all repository runtime file I/O. Do not import `node:fs`.
- Preserve existing behavior unless a task explicitly authorizes a behavior change.
- Do not add provider-specific branches to `compileUserIntentFlow()`.
- Do not mutate `knowledge/public/`, `knowledge/confidential/`, or `knowledge/personal/` during intent compilation.
- Do not auto-promote a reflex.
- Do not cache raw prompts, raw model responses, secrets, approval-sensitive results, or exploratory results.
- Keep new policy files schema-validated and fail closed on invalid policy data.
- Keep unrelated worktree changes untouched.
- Use deterministic tests. Tests must not call a live model or external service.

## 4. Task 1: Advisory Reasoning-Level Decision

### Objective

Add a deterministic, policy-backed reasoning-level decision to the intent flow without changing which backend is called or how many LLM calls occur.

### Files in scope

- Add `libs/core/reasoning-level-policy.ts`
- Add `libs/core/reasoning-level-policy.test.ts`
- Add `knowledge/product/governance/reasoning-level-policy.json`
- Add `knowledge/product/schemas/reasoning-level-policy.schema.json`
- Modify `libs/core/intent-contract.ts`
- Modify `libs/core/intent-contract.test.ts`
- Modify `libs/core/index.ts` only if the new types/functions are not already exported through an existing barrel pattern
- Modify governance/schema catalog checks only when required by the repository's existing registration pattern

### Required contract

Define these internal types:

```ts
export type ReasoningLevel =
  | 'COGNITIVE_EXPLORATORY'
  | 'COGNITIVE_STANDARD'
  | 'REACTION_FAST'
  | 'REFLEX_DETERMINISTIC';

export interface ReasoningLevelDecision {
  level: ReasoningLevel;
  rule_id: string;
  reasons: string[];
  policy_version: string;
  advisory: true;
}
```

Add `reasoningDecision: ReasoningLevelDecision` to `UserIntentFlow`.

Expose one pure decision function with injectable policy data so tests do not rewrite governance files:

```ts
resolveReasoningLevelDecision(
  input: {
    isSimpleGreeting: boolean;
    resolutionPacket: IntentResolutionPacket;
    selectedIntent?: StandardIntentDefinition;
  },
  policy?: ReasoningLevelPolicy,
): ReasoningLevelDecision
```

Keep policy loading and schema validation in a separate `loadReasoningLevelPolicy()` function. Follow the cache-reset pattern in `reasoning-backend-policy.ts` for deterministic tests.

### First-pass policy rules

Evaluate the first matching rule in this order:

1. `simple-greeting-reflex`: when the existing simple-greeting predicate matches, return `REFLEX_DETERMINISTIC`.
2. `high-risk-exploratory`: when the selected standard intent has `risk_profile` equal to `approval_required` or `high_stakes`, return `COGNITIVE_EXPLORATORY`.
3. `ambiguous-exploratory`: when there is no selected intent or `selected_confidence < 0.65`, return `COGNITIVE_EXPLORATORY`.
4. `known-low-risk-fast`: when `selected_confidence >= 0.85`, the selected intent risk is `low`, and the selected shape is `direct_reply` or `task_session`, return `REACTION_FAST`.
5. `default-standard`: otherwise return `COGNITIVE_STANDARD`.

The thresholds and allowed shapes must live in the JSON policy, not as unexplained numeric literals in TypeScript. Reuse `resolveIntentResolutionPacket()` and `loadStandardIntentCatalog()`; do not create a second intent classifier.

### Integration requirements

- Compute the decision after `resolutionPacket` is available and before LLM compilation begins.
- Preserve the existing simple-greeting bypass exactly.
- Return the decision for every path, including thrown-backend fallback paths.
- Do not use the decision to select a model in this task.

### Required tests

- A greeting returns `REFLEX_DETERMINISTIC` and makes zero `askFn` calls.
- A high-risk catalog intent returns `COGNITIVE_EXPLORATORY`.
- An unresolved or low-confidence request returns `COGNITIVE_EXPLORATORY`.
- A known low-risk direct request returns `REACTION_FAST`.
- A remaining request returns `COGNITIVE_STANDARD`.
- Invalid policy JSON is rejected by schema validation.
- Existing intent-contract tests remain unchanged in meaning and pass.

### Verification

```bash
pnpm exec vitest run libs/core/reasoning-level-policy.test.ts libs/core/intent-contract.test.ts
pnpm run check:contract-schemas
pnpm run check:governance-rules
pnpm build
```

### Completion condition

The returned flow explains the advisory level and rule, while LLM call count and backend selection remain identical to the pre-change behavior.

## 5. Task 2: Intent Compilation Telemetry

### Prerequisite

Task 1 is complete and passing.

### Objective

Emit traceable intent-compilation metadata without persisting a trace inside the compiler.

### Files in scope

- Modify `libs/core/intent-contract.ts`
- Modify `libs/core/intent-contract.test.ts`
- Use the existing `TraceContext` type from `libs/core/src/trace.ts`; do not create another trace abstraction

### Required changes

Extend the compile options with an optional trace-compatible sink:

```ts
trace?: Pick<TraceContext, 'addEvent'>;
```

Emit exactly one `intent_compilation.completed` event before returning. Use primitive trace attributes only:

- `reasoning_level`
- `reasoning_rule_id`
- `source`
- `selected_intent_id`
- `selected_confidence`
- `compiler_provider`
- `compiler_model`
- `cache_status` with the fixed value `disabled`
- `fallback_reason` when compilation fell back

Track fallback reasons as a closed internal union:

- `simple_greeting`
- `execution_brief_invalid`
- `intent_contract_invalid`
- `work_loop_invalid`
- `backend_error`
- `none`

Do not persist the trace in `compileUserIntentFlow()`. The caller owns trace persistence.

### Required tests

- A successful LLM flow emits one event with `source=llm`.
- A greeting emits one event with `fallback_reason=simple_greeting`.
- Invalid JSON emits one event with the applicable fallback reason.
- A thrown `askFn` emits one event with `fallback_reason=backend_error`.
- No trace option preserves current behavior and does not throw.

### Verification

```bash
pnpm exec vitest run libs/core/intent-contract.test.ts libs/core/src/trace.test.ts
pnpm build
```

### Completion condition

Every intent-flow result can be observed by an injected trace sink, and the compiler performs no new file writes.

## 6. Task 3: Shadow Model Mapping Only

### Prerequisite

Tasks 1 and 2 are complete and passing.

### Objective

Map reasoning levels to approved model IDs for measurement, but do not dispatch to those models yet.

### Files in scope

- Add `libs/core/reasoning-model-routing.ts`
- Add `libs/core/reasoning-model-routing.test.ts`
- Modify `knowledge/product/governance/reasoning-level-policy.json`
- Modify `knowledge/product/schemas/reasoning-level-policy.schema.json`
- Read model eligibility from `knowledge/product/governance/model-registry.json`
- Modify `libs/core/intent-contract.ts` only to attach shadow metadata and telemetry

### Required behavior

- `COGNITIVE_EXPLORATORY` maps to the approved primary intent compiler.
- `COGNITIVE_STANDARD` maps to the approved primary intent compiler.
- `REACTION_FAST` may map to `openai:gpt-5.4-mini` only while it is present in the registry and has `intent_compiler` role fit of `secondary` or `primary`.
- `REFLEX_DETERMINISTIC` maps to no model.
- If a configured model is absent or ineligible, fail closed to the approved primary intent compiler and include a reason.
- Add `recommended_model_id` and `model_route_status=shadow` to telemetry.
- Do not alter `defaultAsk()`, `ReasoningBackend.prompt()`, backend registration, or actual provider/model selection in this task.

### Required tests

- Each reasoning level returns the expected shadow mapping.
- Missing or ineligible mini model falls back to the approved primary model.
- Reflex returns no model.
- The number and order of `askFn` calls remain unchanged.

### Verification

```bash
pnpm exec vitest run libs/core/reasoning-model-routing.test.ts libs/core/intent-contract.test.ts
pnpm run check:contract-schemas
pnpm run check:governance-rules
pnpm build
```

### Completion condition

Kyberion reports which model it would use, but production execution is unchanged. Actual per-call model dispatch requires a separate RFC because the current reasoning backend contract exposes only `prompt(prompt)` on the registered backend.

## 7. Task 4: Deterministic Intent-Flow Cache

### Prerequisite

Tasks 1 through 3 are complete, shadow telemetry has been evaluated, and cache activation is explicitly approved.

### Objective

Cache only validated, low-risk normalized `UserIntentFlow` results for the `REACTION_FAST` lane.

### Files in scope

- Add `libs/core/intent-flow-cache.ts`
- Add `libs/core/intent-flow-cache.test.ts`
- Add `knowledge/product/schemas/intent-flow-cache.schema.json`
- Modify `libs/core/intent-contract.ts`
- Modify `libs/core/intent-contract.test.ts`

### Storage and key

- Store runtime data at `active/shared/runtime/intent-flow-cache.json` through `secure-io` and `pathResolver.shared()`.
- Hash a canonical JSON object with SHA-256.
- The key object must contain normalized intent text, locale, tier, channel, sorted service bindings, runtime-context fingerprint, intent-resolution selected ID and confidence band, reasoning level, reasoning-policy version, intent-contract schema version, and recommended model ID.
- Never include secret values. If runtime context cannot be reduced to an explicit allowlist, mark the request uncacheable.

### Read eligibility

All conditions must be true:

- reasoning level is `REACTION_FAST`
- selected intent exists with confidence at least `0.85`
- selected catalog risk is `low`
- request tier is explicitly `public` or `confidential`; an absent tier is not cacheable
- no approval-sensitive signal is present
- exact cache key matches

### Write eligibility

All read conditions must be true, plus:

- result source is `llm`
- `intentContract.approval.requires_approval` is false
- `intentContract.clarification_needed` is false
- all returned structures pass their existing validators

### Required behavior

- Validate the cache file and each cached payload before reuse.
- Treat missing, invalid, expired, or version-mismatched entries as misses.
- Use a policy-configured TTL; default to 24 hours.
- Cache hit bypasses all three compilation LLM calls.
- Cache failure must never prevent normal compilation.
- Telemetry `cache_status` is one of `disabled`, `miss`, `hit`, `invalid`, or `write`.
- Do not use `intent-contract-learning.ts` as the cache store. Learned contract memory and exact result caching have different lifecycles.

### Required tests

- Eligible second call is a cache hit and makes zero `askFn` calls.
- Text, locale, tier, channel, bindings, context fingerprint, policy version, schema version, or model ID drift causes a miss.
- Exploratory, standard, reflex, approval-required, clarification-required, and personal-tier flows are not written.
- Invalid cache JSON fails open to normal compilation.
- Expired entries miss.
- Tests restore or remove runtime cache state in `afterAll` using `secure-io`.

### Verification

```bash
pnpm exec vitest run libs/core/intent-flow-cache.test.ts libs/core/intent-contract.test.ts
pnpm run check:contract-schemas
pnpm run check:governance-rules
pnpm build
```

### Completion condition

Only exact, validated, low-risk requests bypass LLM compilation, and every bypass is visible in telemetry.

## 8. Task 5: Reflex Candidate Queue Integration

### Prerequisite

Tasks 1 through 4 are stable and repeated-success evidence exists.

### Objective

Create governed reflex candidates from repeated successful deterministic patterns. Do not promote them automatically.

### Files in scope

- Prefer extending `libs/core/memory-promotion-queue.ts`
- Prefer extending `libs/core/memory-promotion-workflow.ts` only if the existing workflow cannot represent the candidate
- Add focused tests beside the changed module
- Do not create a parallel promotion queue

### Eligibility

Require all of the following:

- at least 5 successful samples
- success rate at least `0.95`
- no unresolved recent failure
- identical intent ID and contract reference
- deterministic or replayable execution shape
- at least one evidence reference
- explicit sensitivity tier

Create a candidate with `status=queued` and `ratification_required=true`. Map it to the existing `sop` or `heuristic` memory kind. Do not write a procedure file and do not call `promoteMemoryCandidateToKnowledge()` from intent execution.

### Required tests

- Fewer than 5 samples does not queue a candidate.
- Success rate below `0.95` does not queue a candidate.
- A recent failure does not queue a candidate.
- An eligible pattern queues exactly one candidate with evidence and ratification required.
- Re-evaluation does not create a duplicate queued candidate.
- Public-tier candidates reject confidential or personal evidence references through the existing guard.

### Verification

```bash
pnpm exec vitest run libs/core/memory-promotion-queue.test.ts libs/core/memory-promotion-workflow.test.ts libs/core/intent-contract-learning.test.ts
pnpm build
```

### Completion condition

Stable patterns enter the existing governed review queue, but no reflex becomes executable without ratification and the existing promotion workflow.

## 9. Explicitly Deferred Work

Do not include these changes in Tasks 1 through 5:

- Changing `ReasoningBackend.prompt()` to accept a per-call provider or model
- Live dispatch to GPT-5.4 mini
- Automatic fallback from mini to GPT-5.4 based on validation failure
- Token accounting from provider usage responses
- Automatic reflex file generation under any knowledge tier
- Public API or extension-contract changes

Each item changes a wider runtime contract and requires separate design and compatibility review.

## 10. Copy-Paste Instruction Header for GPT-5.4 mini

Use this header before the selected task text:

```text
Implement only the task below in /Users/famao/kyberion.
Read AGENTS.md first and run the required baseline check.
Do not implement later tasks, do not change public extension surfaces, and do not touch unrelated worktree files.
Use @agent/core/secure-io for runtime file I/O and apply repository schema-validation patterns.
Run every verification command listed in the task. If a command fails, fix only failures caused by this task and report unrelated pre-existing failures separately.
At completion, report changed files, behavior changes, test results, and any deferred issue. Do not commit or push unless explicitly requested.
```
