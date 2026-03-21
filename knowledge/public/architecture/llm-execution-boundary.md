# LLM Execution Boundary

Kyberion separates the role of the LLM from the role of deterministic execution.
The governing principle is:

`The LLM interprets, compares, and explains. Actuators execute, record, and reproduce.`

## Why This Boundary Exists

If this boundary is unclear, the system drifts into failure modes such as:

- ambiguous requests becoming direct physical actions
- execution reasons becoming detached from execution records
- reduced reproducibility across similar requests
- poor expectation-setting with human operators

For that reason, the LLM and the execution layer must remain connected but distinct.

## Three Zones

### 1. LLM Zone

The LLM is primarily responsible for:

- intent interpretation
- request summarization
- missing-input detection
- alternative comparison
- human-facing explanation
- turning findings into next-action language

The output of this zone is not a final execution command.
It is `pre-contract judgment`.

### 2. Contract Zone

Between the LLM and the Actuators, Kyberion should always place a structured contract.

Typical examples include:

- execution brief
- status brief
- resolution plan
- pipeline bundle
- execution plan set
- system status report
- delivery pack
- operator interaction packet

This is the most important boundary in the system.
Free-form reasoning becomes `ADF` here.

### 3. Deterministic Execution Zone

Actuators and runtime components are responsible for:

- pipeline expansion
- actuator execution
- artifact production
- health and status collection
- evidence retention
- governed-path persistence

In this zone, behavior should be as reproducible as possible.

## Approved Flow

```text
Human request
  -> LLM interpretation
  -> ADF contract
  -> deterministic actuator execution
  -> evidence / delivery pack
  -> operator packet / next action
```

That order is intentional and should not be bypassed.

## What the LLM Must Not Do Directly

The LLM should not directly:

- perform ad hoc execution outside governed paths
- take destructive actions without explicit rationale and gating
- bypass actuator contracts for browser, system, or mobile actions
- declare completion without evidence

## What Actuators Must Not Decide

Actuators should not decide:

- the user's real intent
- which alternative is strategically better
- how to interpret missing information
- whether a higher-risk change should proceed

Actuators are not the interpreter of `why`.
They are the executor of `what to execute`.

## Human Touchpoints

The LLM should appear to the human operator at a small number of explicit touchpoints:

### 1. Intent Normalization

Return a concise explanation of what the request means.

### 2. Clarification

Ask only for the minimum missing information that blocks safe progress.

### 3. Execution Preview

Explain what the system is about to do and what it expects to return.

### 4. Status / Next Action

Explain the current state and what action is recommended next.

In Kyberion, these touchpoints should be expressed through the `operator-interaction-packet`.

The LLM may also absorb multilingual input and normalize it into English-first canonical contracts.
That normalization role is preferable to building parallel multilingual control contracts.

## Sudo Gate Placement

The Sudo Gate should sit at the `contract -> execution` boundary.

That means:

- the LLM interprets human intent
- the intended execution is made explicit in a contract
- high-risk execution asks for approval against that contract

This preserves explainability while keeping execution safe.

## Practical Rule

The short operational rule is:

- `If it is interpretation or explanation, prefer the LLM`
- `If it is persistence or execution, prefer an Actuator`
- `Between them, always require ADF`

For localization, the companion rule is:

- `If it is a fixed UI label, prefer a governed catalog`
- `If it is free-form explanation, prefer the LLM`
