# Operator UX Guide

Kyberion has a rich internal model, but the operator UX should still be easy to explain:

```text
Intent -> Plan -> State -> Result
```

This guide explains how to operate Kyberion without forcing people to think in raw pipelines, runtime registries, or actuator contracts first.

For enterprise role separation above the operator layer, also read:

- `knowledge/public/architecture/enterprise-operating-kernel.md`
- `knowledge/public/architecture/ceo-ux.md`
- `knowledge/public/architecture/management-control-plane.md`
- `knowledge/public/architecture/surface-responsibility-model.md`

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

When Kyberion explains a complex capability, it should surface the
governed capability bundle summary before expanding into the underlying
actuator or pipeline details.

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
- project, track, gate, and mission-seed control

Chronos is the control surface.
It explains and intervenes, but it does not replace the durable control plane.

### Presence Studio

Use when you want:

- conversational interaction
- hands-free or voice interaction
- browser assistance
- live task detail and artifact access
- immediate project bootstrap context

### CEO UX

Use when you want:

- leadership-level request intake
- approval review
- latest strategic outcomes
- major exception visibility

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
- `Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる`
  - Kyberion resolves this to `meeting-operations`, then asks for the meeting URL, role boundary, and purpose if they are missing
- `スケジュールを調整して`
  - Kyberion resolves this to `schedule-coordination`, then asks for the schedule scope, date range, fixed constraints, and calendar-action boundary if they are missing
  - If the adjustment is for a live meeting, Kyberion may hand off from `schedule-coordination` to `meeting-operations` once the meeting-specific authority boundary matters

The user should ask for outcomes.
Kyberion should choose the machinery.

### How To Form A Good Request

Use a short outcome-first request and add only the variables that affect the result.

Recommended structure:

```text
Goal + Context + Constraints + Approval Boundary
```

Examples:

- `6/6-6/8で沖縄に行くのでおすすめのホテルを探して。予算は1泊2万円前後、那覇か北谷を優先。`
- `今夜のレストランを予約したい。2名で、静かな店を優先。予約前に候補を3件まで絞って。`
- `この要件定義を説明する資料を作って。役員向け、10枚前後、厳しめのトーンで。`
- `voice-hub の状態を見て。異常があれば要点だけ教えて。`
- `Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる。会議URLはこれで、私の役割はファシリテータ。`
- `スケジュールを調整して。誰の予定かは私のカレンダーで、変更は提案までにして。`
- `会議の日程を調整して。参加者調整が必要なら meeting-operations に切り替えて。`
  - Kyberion resolves this to `schedule-coordination` first, then asks one extra boundary question if the request is really about a live meeting: is this only a calendar edit, or should it be handed to `meeting-operations`?

If the task is booking, presentation, narrated video, meeting operations, purchase, renewal, or another structured workflow, Kyberion should first produce an execution brief and ask only the questions that change the outcome.

If you already know you want Kyberion to act with assumptions, say so explicitly:

- `不足があれば先に聞いて`
- `不明点は合理的に仮定して進めて`
- `予約や決済の直前で止めて`

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

For distillation and other structured reasoning tasks, see:

- [`knowledge/public/governance/wisdom-policy-guide.md`](knowledge/public/governance/wisdom-policy-guide.md)

Those flows are policy-driven. The operator should not need to pick a specific CLI provider when `wisdom-policy.json` already defines the profile and adapter.

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

| Path                      | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `knowledge/personal/`     | private local identity, tokens, preferences       |
| `knowledge/confidential/` | sensitive org knowledge                           |
| `knowledge/public/`       | shared reusable knowledge and governance          |
| `active/missions/`        | mission-specific durable state                    |
| `active/shared/`          | shared runtime state, logs, tmp artifacts, queues |
| `libs/actuators/`         | execution capabilities                            |
| `scripts/`                | control-plane and operational entry points        |
| `satellites/`             | external bridges such as Slack                    |
| `presence/displays/`      | control and conversational displays               |

Practical rules:

- personal connection material goes in `knowledge/personal/connections/`
- customer overlay material goes in `customer/{slug}/connections/` when `KYBERION_CUSTOMER` is set
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
pnpm dashboard:onboarding
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
$MC start MY-TASK --tier confidential --persona ecosystem_architect
$MC status MY-TASK
$MC checkpoint MY-TASK step-1 "Progress note"
$MC verify MY-TASK verified "Verification summary"
$MC finish MY-TASK
```

Direct mission commands are for operators.
They are not the primary UX you should teach first.

### Reasoning policy

```bash
cat knowledge/public/governance/wisdom-policy.json
```

Use this when you need to inspect or update which backend profile and adapter is used for distillation.

### Control plane CLI

```bash
pnpm control presence tracks
pnpm control presence ref active/projects/test-web/tracks/TRK-TEST-REL1/02_define/requirements-definition.md

pnpm control chronos tracks
pnpm control chronos mission-seeds
pnpm control chronos ref knowledge/public/templates/blueprints/requirements-traceability-matrix.md
pnpm control chronos seed-track TRK-TEST-REL1 requirements-definition
```

Use this flow when you want to follow the governed operator path directly from the terminal:

```text
Project -> Track -> Gate Readiness -> Next Required Artifact -> Template/Skeleton -> Mission Seed -> Mission
```

`chronos seed-track` remains permission-gated by Chronos localadmin access.

## 9. The Smallest Teaching Version

If you have to explain Kyberion quickly, explain it like this:

1. You tell it what you want.
2. It figures out the plan.
3. It asks only when approval is needed.
4. It shows what is happening.
5. It returns the result and keeps the work inspectable.

## 10. Surface Responsibility Split

The simplest stable split is:

- `Presence Studio`
  - concierge surface for live conversation and immediate work detail
- `Chronos`
  - management control plane for state, intervention, risk, and accountability
- `CEO UX`
  - executive surface for outcome review and approvals

This split matters because it keeps:

- conversation smooth
- operations inspectable
- executive attention high-signal
