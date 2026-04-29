# Architecture: Intent Classifier Routing

## 1. Purpose

Kyberion should let the user speak in outcomes while the system chooses execution machinery.

The routing problem is therefore:

```text
natural language intent
  -> structured resolution
  -> plan
  -> task session, mission, or direct reply
```

The classifier exists to keep that translation fast, understandable, and safe.

## 2. Design Rule

Kyberion should not depend on either of these extremes:

- pure regular-expression routing
- pure LLM-first routing with no deterministic guardrails

Instead it should use:

```text
heuristic-assisted LLM routing
```

## 3. Routing Stack

### 3.1 Hard guards

Deterministic handling for critical short commands.

Examples:

- `はい`
- `いいえ`
- `1つ目`
- `止めて`
- `戻って`

### 3.2 Fast heuristic candidates

Low-latency candidate generation for common work types.

Examples:

- browser open or browser step
- task session creation
- service inspection
- knowledge query
- weather or location query

### 3.3 LLM reranking

The LLM is used to refine or override candidate selection when needed.

It should receive:

- the raw utterance
- current surface context
- active browser session summary
- active task session summary
- heuristic candidate list

### 3.4 Contract-bound execution

The routing result must be expressed as structured data before execution.

The classifier should decide things such as:

- direct reply
- browser operation
- task session type
- mission creation
- approval requirement

Execution then proceeds through validators, policies, and governed actuators.

The routing result should also emit an explainable trace with at least:

- intent
- heuristic candidates
- LLM rerank decision or timeout
- chosen work shape
- policy outcome

## 4. What Should Route Through `compileUserIntentFlow`

The brief-first compiler should own the requests where the user is describing a desired outcome and the system needs to choose a governed work shape.

### 4.1 Should route through `compileUserIntentFlow`

- booking, reservation, purchase, renewal, cancellation, or other structured lifestyle workflows
- presentation, report, workbook, or other document-generation work
- service inspection and service-operation requests that may require clarification or approval
- project bootstrap, remediation, incident review, or other durable work
- browser workflows where the user wants the system to learn the intent, not just perform one click
- any request where the system should first produce an execution brief, ask only outcome-changing questions, then compile the contract
- repeated coordination work that fits the shared `guided-coordination` archetype, such as meetings, decks, narrated videos, schedule reshuffles, and onboarding flows
- any request where the system should first produce a `guided-coordination-brief`, ask only outcome-changing questions, then specialize into an execution brief and contract

### 4.2 Should not route through `compileUserIntentFlow`

- active browser conversation step commands such as `それ`, `1つ目`, `押して`, `入力して`
- lightweight direct answers such as weather, time, simple knowledge lookup, and trivial status checks
- low-level runtime or operator commands such as mission controller control flow
- browser-actuator execution itself after the session has already been normalized into a task session

### 4.3 Why This Split Matters

If a request is routed too early into a low-level classifier, the system can skip the brief, skip the reusable contract, and skip the learning hook.

If a request is routed too late into the compiler, the system becomes over-verbose and loses the low-latency behavior that direct replies and active browser steps need.

The practical rule is:

```text
Goal-level request -> compileUserIntentFlow
step-level command -> local session classifier
```

## 5. Browser Learning Loop

Browser work should learn in layers, not only by keeping a conversation log.

Recommended loop:

1. user requests a browser workflow at the goal level
2. `compileUserIntentFlow()` creates the execution brief and contract
3. browser execution records action trail and trace
4. trace-derived hints are extracted
5. distill candidates are created when a reusable pattern or SOP is visible
6. approved candidates are promoted into governed memory
7. later requests can reuse the promoted memory and contract memory

The important distinction is:

- session history preserves what happened
- trace preserves what was executed
- distill / promote preserves what should be reused

Without the distill/promotion step, the system has history but not learning.

## 6. Distill Candidate Policy

Distill candidates are not the same as every completed execution.

Candidate creation should only happen when the output is likely to be reused as a governed pattern, SOP candidate, report template, or knowledge hint.

### 6.1 Browser candidates

Browser workflows should be considered for distillation only when:

- the workflow has a recorded trace
- the workflow performed at least one interactive `apply` action
- the workflow has enough action trail to show a reusable sequence
- the target context is concrete, such as a URL or window title
- the result is more than a bare `open_site` navigation

Browser workflows should not be distilled when they are only:

- one-click navigation
- generic session opening
- step-level command handling inside an active browser conversation

### 6.2 Task session candidates

Task sessions should be considered for distillation only when:

- the session produced a governed artifact
- the session has a work loop or equivalent governed execution context
- the task type exposes a reusable structure
- the result is not just a generic completion string

Examples that are usually eligible:

- `presentation_deck`
- `report_document`
- `workbook_wbs`
- `service_operation`
- `analysis` when the analysis is specifically a project bootstrap

Examples that should usually not auto-promote:

- generic analysis output
- generic document completions with no reusable structure
- thin success messages that do not expose a repeatable procedure

### 6.3 Promotion boundary

Candidate creation is not promotion.

Promotion should require a separate governed review step, especially when:

- the candidate may cross tiers
- the candidate might leak restricted references
- the pattern is useful but still noisy
- the system is not yet confident that the candidate is stable

The practical progression should be:

```text
execution -> candidate assessment -> proposed candidate -> governed review -> promotion
```

This keeps learning useful without turning every execution into a permanent memory entry.

## 4. Why This Matters

This model gives Kyberion:

- lower latency than full LLM-first routing
- better flexibility than regex-only routing
- replayable behavior
- safer control around risky actions

It also keeps the UX aligned with the product model:

```text
Intent -> Plan -> Result
```

instead of:

```text
Utterance -> fragile tool guess -> opaque failure
```

## 5. Relationship To Missions

Routing does not decide only which actuator to call.
It also decides what durable work shape is appropriate.

Examples:

- direct answer
- task session
- mission

That is the key connection between user UX and the backend execution model.

## 6. Observability

Routing is part of the user experience, so it needs first-class observability.

The recommended trace progression is:

```text
intent -> slot -> plan -> execution -> outcome
```

This keeps the system debuggable without forcing the user to understand raw ADF or actuator internals.
