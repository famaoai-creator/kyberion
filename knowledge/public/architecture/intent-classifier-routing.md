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
