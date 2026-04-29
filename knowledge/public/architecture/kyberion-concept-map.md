# Kyberion Concept Map

Kyberion does not suffer from "too many concepts" as much as it suffers from `multiple layers of concepts becoming visible at the same time`.
The goal is not to reduce concepts arbitrarily, but to make each concept belong to a clear layer.

## Five Layers

### 1. Intent Layer

This is the layer for human interaction and request understanding.

Primary concepts:

- Request
- Clarification
- Operator Interaction Packet
- Operator Response Preview
- Next Action

At this layer, internal concepts such as `mission` or `pipeline bundle` should not dominate the user experience.
The human mainly needs to know:

- what was understood
- what is missing
- what happens next
- what will be returned

### 2. Control Layer

This is the layer for authority, state, traceability, and approvals.

Primary concepts:

- Mission
- Project
- Phase
- Gate
- Ledger
- Mission Controller
- Mission Lease

The key distinction is that `Project` and `Mission` are not the same unit.

- `Project`
  - long-lived governance unit
- `Mission`
  - short-lived execution unit
- `Mission Ledger`
  - traceability bridge between the two

### 3. Knowledge Layer

This is the layer for reusable knowledge, contracts, and governed configuration.

Primary concepts:

- Procedures
- Schemas
- Templates
- Policies
- Catalogs
- Profiles
- Presets

For practical use, Knowledge is easier to manage when split into three categories:

- `governance knowledge`
  - policy, procedure, schema
- `runtime knowledge`
  - profiles, presets, endpoint catalogs
- `content knowledge`
  - themes, blueprints, design templates

### 4. Execution Layer

This is the deterministic physical execution layer.

Primary concepts:

- Actuator
- Pipeline
- Generated Pipeline
- Execution Plan Set
- Delivery Pack
- Surface Runtime

The LLM is not the direct execution authority in this layer.
If LLM reasoning contributes, it should first be reduced into `ADF`.

### 5. Memory Layer

This is the layer for retained evidence and operational history.

Primary concepts:

- Evidence
- Run Report
- Delivery Pack
- Distillation
- Wisdom
- Status Report

Knowledge and Memory are related, but they serve different purposes:

- `Knowledge`
  - something reusable in future work
- `Memory`
  - a record of what happened in this work

## Where Each Core Concept Belongs

| Concept | Primary Layer | Secondary Role |
| --- | --- | --- |
| Sovereign Request | Intent | - |
| Operator Interaction Packet | Intent | contact surface with Control |
| Mission | Control | leaves history in Memory |
| Project Operating System | Control | consumes Knowledge blueprints |
| ADF | Knowledge | bridge into Execution |
| Actuator | Execution | - |
| Delivery Pack | Execution | handoff into Memory |
| Distilled Wisdom | Memory | may later be promoted into Knowledge |

## Boundary Rules

Kyberion preserves consistency at the boundaries between layers.

### Intent -> Control

Never pass an ambiguous request directly to a mission or actuator.
Normalize it first into a `guided-coordination-brief`, `execution brief`, or `status brief` as appropriate.

### Control -> Knowledge

The control layer may consult knowledge, but must not collapse into it.
For example, `mission-state.json` is runtime state, not reusable knowledge.

### Knowledge -> Execution

This boundary should always go through `ADF`.
Free-form reasoning or shell fragments must not be passed directly into actuators.

### Execution -> Memory

Execution results should be retained as evidence, run reports, and delivery packs.
Do not end with a purely conversational "done".

## User-Facing Simplification

Externally, Kyberion should default to four concepts:

- request
- execution unit
- deliverable
- next action

Internally, the system may still use:

- Mission
- Project
- Actuator
- ADF
- Packet
- Ledger
- Delivery Pack

## Reading Order

The recommended path for understanding the overall model is:

1. [`docs/INTENT_LOOP_CONCEPT.md`](../../../docs/INTENT_LOOP_CONCEPT.md)
2. [`docs/USER_EXPERIENCE_CONTRACT.md`](../../../docs/USER_EXPERIENCE_CONTRACT.md)
3. [`docs/COMPONENT_MAP.md`](../../../docs/COMPONENT_MAP.md)
4. [`llm-execution-boundary.md`](llm-execution-boundary.md)
5. [`project-operating-system.md`](../orchestration/project-operating-system.md)

## Cross-Cutting: The Intent Loop

The five layers above describe *where concepts live*. A second, orthogonal view
— the **intent loop** — describes *how intent moves through the system*:

```
receive → clarify → preserve → execute → verify → learn
```

See [`docs/INTENT_LOOP_CONCEPT.md`](../../../docs/INTENT_LOOP_CONCEPT.md) for the
full definition. The loop is the one non-replaceable primitive: reasoning
models, CLI hosts, actuator implementations, and schema names are all
replaceable, but the loop closure is not.

Mapping loop stages onto the five layers:

| Loop Stage | Primary Layer(s) | Example Artifacts |
|---|---|---|
| receive | Intent | request, operator interaction packet |
| clarify | Intent → Control | clarification packet, classification record, hypothesis tree |
| preserve | Control + Knowledge | mission state, execution brief, negotiation state, relationship graph |
| execute | Execution | pipeline run, actuator invocation, decision-ops call |
| verify | Control | review gate verdict, intent-drift gate, golden scenario evaluation |
| learn | Memory → Knowledge | distillation, run report, heuristic entry, hardening backlog |

Intent drift at any stage is a loop failure — mechanisms such as classification
preflight, review gates, execution receipts, and `INTENT_DRIFT` are the detail
instruments that keep the loop closed.
