# Operator UX Guide

Kyberion has a rich internal model, but the operator UX should still be easy to explain:

```text
Intent -> Plan -> State -> Result
```

This guide explains how to operate Kyberion without forcing people to think in raw pipelines, runtime registries, or actuator contracts first.

## 1. The Core UX Contract

Every surface should make these four things visible:

- `Intent`
  - what the user asked for
- `Plan`
  - what Kyberion decided to do
- `State`
  - what is happening now
- `Result`
  - answer, artifact, approval, or next step

Internally, Kyberion may use:

- missions
- task sessions
- browser conversation sessions
- actuators
- ADF pipelines
- runtime supervision

Those are execution details behind the contract above.

## 2. Choosing A Surface

### Terminal

Use when you want:

- code changes
- tests and diffs
- close technical iteration
- direct debugging

### Slack

Use when you want:

- remote requests
- approvals in-thread
- short follow-ups
- result delivery back into the same thread

Slack is a governed ingress and delivery surface.
It is not the durable mission owner.

### Chronos Mirror

Use when you want:

- operator visibility
- runtime and mission state
- intervention points
- delivery inspection

Chronos is the control surface.
It explains and intervenes, but it does not replace the durable control plane.

### Presence Studio

Use when you want:

- conversational interaction
- hands-free or voice interaction
- browser assistance
- live task detail and artifact access

## 3. What The User Says vs What Kyberion Does

Examples:

- `このPDFをパワポにして`
  - Kyberion resolves this to a document-generation path
- `日経新聞を開いて`
  - Kyberion resolves this to browser navigation
- `voice-hub の状態を見て`
  - Kyberion resolves this to a service inspection path
- `今週の進捗レポートを作って`
  - Kyberion resolves this to a task session or mission-backed document flow

The user should ask for outcomes.
Kyberion should choose the machinery.

## 4. How To Explain The Backend Model

When you do need to explain the internal model, use this hierarchy:

### Direct reply

For lightweight questions.

Examples:

- weather
- location
- knowledge lookup
- simple system status

### Task session

For conversational work that still needs structure and progress.

Examples:

- generate a PowerPoint
- generate a report
- inspect a service
- capture a photo
- interactive browser work

### Mission

For larger durable work that needs evidence, validation, ownership, or distillation.

Examples:

- engineering implementation
- multi-step delivery
- cross-agent work
- auditable workflows

## 5. Chronos Mental Model

Chronos is easiest to understand as a control tower.

It helps answer:

1. What did the user ask for?
2. What plan is running?
3. What is blocked or waiting?
4. What needs approval or intervention?
5. What artifact or result came out?

Chronos is not a general chat app and not a raw process monitor.

## 6. Presence Studio Mental Model

Presence Studio should feel like the conversational front desk.

It is responsible for:

- receiving live human intent
- keeping the conversation smooth
- surfacing short plans
- showing active browser and task detail
- returning artifacts and results

It should not force the user to manually think in:

- task IDs
- pipeline steps
- runtime names

Those may be inspectable, but they should not be the default conversation burden.

## 7. Directory Model

The most useful directory model for operators is by purpose.

| Path | Purpose |
| --- | --- |
| `knowledge/personal/` | private local identity, tokens, preferences |
| `knowledge/confidential/` | sensitive org knowledge |
| `knowledge/public/` | shared reusable knowledge and governance |
| `active/missions/` | mission-specific durable state |
| `active/shared/` | shared runtime state, logs, tmp artifacts, queues |
| `libs/actuators/` | execution capabilities |
| `scripts/` | control-plane and operational entry points |
| `satellites/` | external bridges such as Slack |
| `presence/displays/` | control and conversational displays |

Practical rules:

- personal connection material goes in `knowledge/personal/connections/`
- durable mission evidence goes in `active/missions/`
- shared logs and tmp artifacts go in `active/shared/`
- reusable policies, schemas, and procedures belong in `knowledge/public/`

## 8. Daily Commands

### Setup and health

```bash
pnpm install
pnpm build
pnpm onboard
pnpm doctor
pnpm capabilities
```

### Surface lifecycle

```bash
pnpm surfaces:reconcile
pnpm surfaces:status
pnpm surfaces:stop
```

### Chronos

```bash
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

### Capability discovery

```bash
pnpm run cli -- list
pnpm run cli -- search browser
pnpm run cli -- info browser-actuator
```

### Direct mission control

```bash
MC="node dist/scripts/mission_controller.js"
$MC start MY-TASK confidential
$MC status MY-TASK
$MC checkpoint step-1 "Progress note"
$MC verify MY-TASK verified "Verification summary"
$MC finish MY-TASK
```

Direct mission commands are for operators.
They are not the primary UX you should teach first.

## 9. The Smallest Teaching Version

If you have to explain Kyberion quickly, explain it like this:

1. You tell it what you want.
2. It figures out the plan.
3. It asks only when approval is needed.
4. It shows what is happening.
5. It returns the result and keeps the work inspectable.
