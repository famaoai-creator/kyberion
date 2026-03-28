# Kyberion

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repository](https://img.shields.io/badge/GitHub-kyberion-181717.svg?logo=github)](https://github.com/famaoai-creator/kyberion)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933.svg?logo=node.js)](https://nodejs.org/)

Kyberion is an intent-driven agent operating system.

The intended user experience is simple:

1. Tell Kyberion what you want.
2. Kyberion decides how to do it.
3. Kyberion asks only when approval is required.
4. Kyberion returns a result, an artifact, or a clear next step.

Internally, Kyberion uses missions, task sessions, actuators, ADF pipelines, runtime supervision, and governed knowledge. Those are implementation details of a durable execution model, not the interface you should have to think about first.

For the operator-oriented view of Slack, Chronos, directories, and daily commands, see [docs/OPERATOR_UX_GUIDE.md](/Users/famao/kyberion/docs/OPERATOR_UX_GUIDE.md).

## The Product Model

Kyberion should feel like this:

```text
Intent -> Plan -> Result
```

Examples:

- `このPDFをパワポにして`
- `日経新聞を開いて`
- `今週の進捗レポートを作って`
- `voice-hub の状態を見て`

What Kyberion does next:

- interprets the request as an intent
- resolves the right execution path
- proposes or applies a short plan
- runs the work through governed execution
- returns a result, artifact, or approval request

## What The User Should See

Kyberion should expose four things clearly:

- `Intent`
  - what the user asked for
- `Plan`
  - what the system is about to do in human terms
- `State`
  - running, waiting for input, waiting for approval, completed, failed
- `Result`
  - artifact, answer, or concrete next action

Kyberion should not require the user to think in terms of:

- actuator names
- raw ADF JSON
- runtime supervisors
- internal mission events

Those remain important, but they belong behind the user-facing interface.

## Surfaces

Kyberion can be used through multiple surfaces, but they should all present the same mental model.

### Terminal

Best for:

- coding work
- debugging
- test-driven development
- precise review and iteration

### Slack

Best for:

- lightweight remote requests
- approvals and follow-ups
- receiving results back in-thread

### Chronos Mirror

Best for:

- observing what the system is doing
- inspecting runtime state and mission state
- intervening when something needs operator attention

### Presence Studio

Best for:

- conversational interaction
- voice interaction
- live browser and task assistance

## Intent, Plan, and Result

The central design rule is:

```text
Natural language request
  -> intent resolution
  -> execution plan
  -> governed execution
  -> observable result
```

In practice:

- simple questions may return a direct answer
- operational requests may create a task session
- broader durable work may become a mission
- risky changes may pause for approval

The user should not need to choose between these paths explicitly.

## Internal Model

Kyberion stays reliable by separating the user-facing model from the execution model.

### Intent

The human request.

Examples:

- `このPDFをパワポにして`
- `Chrome で日経新聞を開いて`
- `今のミッション一覧を教えて`

### Resolution

The structured interpretation of what the user means.

Examples:

- direct answer
- browser operation
- knowledge query
- task session
- durable mission

### Plan

A short execution plan in human terms, usually rendered as a few steps.

Examples:

- `PDF を解析 -> スライド構成を復元 -> PPTX を生成`
- `検索 -> サイトを開く`
- `状態を取得 -> 要点を返す`

### Execution

The internal layer where Kyberion uses missions, sessions, actuators, and ADF.

This layer exists for durability, governance, replayability, and safety.

## Missions and Task Sessions

Kyberion has two important durable work shapes.

### Task Session

A lightweight execution contract for conversational work.

Use cases:

- create a PowerPoint
- create a report
- inspect a service
- capture a photo
- operate the browser interactively

Task sessions are good when the work should feel conversational and return quickly with artifacts or follow-up prompts.

### Mission

A larger durable unit of work with its own evidence trail and lifecycle.

Use cases:

- multi-step engineering work
- long-running delivery work
- auditable cross-agent execution
- reusable evidence and distillation

Mission lifecycle:

```text
planned -> active -> validating -> distilling -> completed -> archived
```

Rule of thumb:

- `simple request` -> direct answer or task session
- `durable work` -> mission

## Why Missions Still Matter

Kyberion is not trying to expose missions because users love lifecycle state machines.
It uses missions because they provide:

- durable ownership
- replayable evidence
- explicit validation
- safe delegation
- knowledge distillation after completion

The UX goal is not to remove the mission model.
It is to make the mission model feel invisible until the user needs it.

## Actuators and ADF

Actuators are Kyberion's execution body.
ADF is the structured contract used to connect reasoning and execution.

Examples of actuator families:

- browser
- media
- system
- service
- file
- terminal
- wisdom

Examples of ADF-backed work:

- PDF to PPTX conversion
- browser navigation and page interaction
- report generation
- service inspection
- controlled secret mutation

Users should usually ask for outcomes.
Kyberion decides which actuators and ADF contracts to use.

## Architecture

```text
Intent
  -> surface ingress (Terminal / Slack / Presence / Chronos)
  -> intent resolution
  -> short plan / confirmation
  -> task session or mission
  -> runtime supervisor / orchestration
  -> actuators and ADF pipelines
  -> artifacts, answers, and notifications
```

Core locations:

| Path | Role |
| --- | --- |
| `libs/core/` | shared kernel: secure I/O, resolution, routing, runtime state, governance helpers |
| `libs/actuators/` | execution capabilities |
| `knowledge/` | reusable governed knowledge |
| `scripts/` | operational entry points |
| `pipelines/` | declarative execution plans |
| `active/` | runtime state, missions, artifacts, and logs |
| `satellites/` | channel bridges such as Slack |
| `presence/displays/` | operator and conversational displays |

## Getting Started

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install
pnpm build
pnpm onboard
pnpm surfaces:reconcile
```

Fastest daily-use docs:

- [docs/QUICKSTART.md](/Users/famao/kyberion/docs/QUICKSTART.md)
- [docs/OPERATOR_UX_GUIDE.md](/Users/famao/kyberion/docs/OPERATOR_UX_GUIDE.md)

## Local Control Plane

```bash
pnpm agent-runtime:supervisor
pnpm mission:orchestrator
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

## Working With Missions Directly

If you need direct mission control, use the mission controller.

```bash
MC="node dist/scripts/mission_controller.js"
$MC start MY-FEATURE confidential
$MC checkpoint task-1 "Implemented auth module"
$MC verify MY-FEATURE verified "All tests pass"
$MC finish MY-FEATURE
```

Direct mission commands are for operators and internal control.
They are not the primary user-facing interface.

## Documents Worth Reading

- [docs/QUICKSTART.md](/Users/famao/kyberion/docs/QUICKSTART.md)
- [docs/OPERATOR_UX_GUIDE.md](/Users/famao/kyberion/docs/OPERATOR_UX_GUIDE.md)
- [docs/GLOSSARY.md](/Users/famao/kyberion/docs/GLOSSARY.md)
- [docs/COMPONENT_MAP.md](/Users/famao/kyberion/docs/COMPONENT_MAP.md)
- [CAPABILITIES_GUIDE.md](/Users/famao/kyberion/CAPABILITIES_GUIDE.md)
- [knowledge/public/architecture/kyberion-surface-ux-architecture.md](/Users/famao/kyberion/knowledge/public/architecture/kyberion-surface-ux-architecture.md)
- [knowledge/public/architecture/agent-mission-control-model.md](/Users/famao/kyberion/knowledge/public/architecture/agent-mission-control-model.md)
