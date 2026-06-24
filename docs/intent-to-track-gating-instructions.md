# Implementation Instructions: Intent-to-Track Policy Gating

This document defines the requirements, architecture, and step-by-step implementation tasks to build the **Intent-to-Track Policy Gating** feature. 

These instructions are tailored for **Codex (GPT-5.4/5.5)** to implement the complete routing and verification pipeline without human intervention.

---

## 1. Purpose & Core Goals

Fusing the **Intent Resolution Engine** with the **SDLC Track Gating Model** enables Kyberion to dynamically provision a structured **Track** (and initial execution **Mission**) immediately upon classifying a user's natural language request. 

### Exit Criteria (Definition of Done)
1. **Validation Passing**: `pnpm build`, `pnpm run typecheck`, and `pnpm run validate` pass with no errors.
2. **Deterministic Gating Test**: Integration tests verify:
   * **High Confidence (>= 0.75)**: Correctly merges tenant overrides and auto-provisions the Track + Mission.
   * **Low Confidence (< 0.75)**: Correctly halts execution and prompts the user for explicit verification.
3. **No Code Bypass**: Creation of a Track via Intent must always enforce the defined Gating profile. No inbound intent should bypass the security validation rules.
4. **I/O Guardrails**: All file reads/writes in the resolver must use `@agent/core/secure-io` and `pathResolver` helpers. No direct `node:fs` usage.

---

## 2. Target Flow

```text
User Request (NL) 
  ──▶ Intent Classifier (Intent ID & Confidence Score)
  ──▶ [Confidence Check]
         ├── High (>= 0.75) ──▶ Load & Merge Policies ──▶ Auto-Start Track/Mission & Notify
         └── Low  (< 0.75)  ──▶ Halt ──▶ Ask User for Confirmation (Interactive Prompt)
```

---

## 3. Data Structures & Policy Override Layout

### 3.1 Extension of `intent-routing-map.json`
Update [knowledge/product/governance/intent-routing-map.json](file:///Users/famao/kyberion/knowledge/product/governance/intent-routing-map.json) to contain the `"track_intent_policy_map"` configuration:

```json
{
  "track_intent_policy_map": {
    "request-feature-development": {
      "track_type": "delivery",
      "default_lifecycle": "default-sdlc",
      "min_confidence_to_autostart": 0.75
    },
    "remediate-security-incident": {
      "track_type": "incident",
      "default_lifecycle": "incident-response",
      "min_confidence_to_autostart": 0.85
    },
    "explore-product-solution": {
      "track_type": "product_discovery",
      "default_lifecycle": "discovery-sdlc",
      "min_confidence_to_autostart": 0.75
    },
    "apply-infrastructure-change": {
      "track_type": "change",
      "default_lifecycle": "change-control",
      "min_confidence_to_autostart": 0.80
    }
  }
}
```

### 3.2 Hierarchical Policy Overrides
The resolver must load policies in the following sequence and deep-merge them:
1. **Global Default**: [knowledge/product/governance/track-creation-policy.json](file:///Users/famao/kyberion/knowledge/product/governance/track-creation-policy.json)
2. **Tenant Override**: `knowledge/personal/connections/track-policy-override.json` (or context-specific tenant folder, e.g., `confidential/{tenant_id}/governance/track-policy-override.json`).

*Merge Strategy*: Sub-keys (like `entry_criteria`, `exit_criteria`, `phases`) specified in the override file will overwrite or append to the global default values.

---

## 4. Implementation Steps (Tasks for Codex)

Every task must be implemented as a separate step, verified with focused unit tests.

### Task 1: Update Schemas and Intent Maps
* **Target Files**:
  * `schemas/track-policy-override.schema.json` (Create)
  * [knowledge/product/governance/intent-routing-map.json](file:///Users/famao/kyberion/knowledge/product/governance/intent-routing-map.json) (Modify)
* **Goal**:
  Define valid schema for tenant-specific policy overrides and add `track_intent_policy_map` to the routing map.
* **Verification**: `pnpm run check:contract-schemas` passes.

### Task 2: Implement Policy Merge Logic
* **Target Files**:
  * `libs/core/intent-track-resolver.ts` (Create)
  * `libs/core/intent-track-resolver.test.ts` (Create)
  * Export public functions in `libs/core/index.ts`.
* **Required APIs**:
  * `resolveIntentToTrackPolicy(intentId: string, tenantId?: string): Promise<TrackPolicy>`
  * It must resolve `intentId` to the track mapping, fetch the global policy, load tenant override files if they exist, deep-merge them, and validate the final merged object against the schema.
* **Verification**: Run `pnpm exec vitest run libs/core/intent-track-resolver.test.ts`.

### Task 3: Implement Confidence & Autostart Gates
* **Target Files**:
  * Extend `libs/core/intent-track-resolver.ts`.
  * Add unit tests for confidence logic.
* **Required Logic**:
  * If the resolved intent's confidence is `< min_confidence_to_autostart`, return a result shape denoting `{ status: "escalation_required", reason: "low_confidence", confidence: X }`.
  * Otherwise, return `{ status: "ready_to_provision", policy: EffectivePolicy }`.
* **Verification**: Tests verifying successful auto-starts and correct escalations pass.

### Task 4: Connect to `mission_controller.ts` & CLI
* **Target Files**:
  * [scripts/mission_controller.ts](file:///Users/famao/kyberion/scripts/mission_controller.ts)
  * CLI orchestration commands.
* **Required Integration**:
  * When executing an intent with `execution_shape = "project_bootstrap"` or `"mission"`, the controller must call the resolver.
  * If `status === "ready_to_provision"`, instantiate the Track and prompt a console log notification.
  * If `status === "escalation_required"`, prompt an interactive confirmation (Y/N) or trigger `/grill-me` style input collection via CLI.
* **Verification**: `pnpm build` completes with zero type errors.

### Task 5: End-to-End Verification Test
* **Target Files**:
  * `tests/intent-to-track-integration.test.ts` (Create)
* **Scenarios to Test**:
  1. High-confidence intent (`request-feature-development`, conf: 0.90) auto-provisions a Track of type `delivery` with standard SDLC.
  2. The E2E test validates that the effective track enforces all gates in `default-sdlc`.
  3. Low-confidence intent stops and prompts user validation.
* **Verification**: Run `pnpm exec vitest run tests/intent-to-track-integration.test.ts`.
