# Quick Start

Kyberion should be approached as an intent-driven system.

Start with:

```text
Intent -> Plan -> Result
```

Not with:

```text
Actuator -> ADF -> internal runtime detail
```

## 1. Setup

Prerequisites:

- Node.js `22+`
- `pnpm`

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install
pnpm prereq:check
pnpm build
pnpm onboard          # customer/{slug}/ preferred when KYBERION_CUSTOMER is set
pnpm surfaces:reconcile
```

## 2. First Win Smoke

If you only want the shortest path to a visible result, start here.

The first-win path is intentionally staged:

- 30 seconds: `pnpm doctor` shows whether the local runtime is ready and what value boundary is currently blocked
- 5 minutes: `pnpm pipeline --input pipelines/verify-session.json` writes `active/shared/tmp/first-win-session.png`
- optional voice path: `pnpm pipeline --input pipelines/voice-hello.json`
- 15 minutes: skim sections 4-10, then open `pipelines/verify-session.json`, `CAPABILITIES_GUIDE.md`, and `docs/developer/EXTENSION_POINTS.md` to understand the structure

```bash
pnpm doctor
pnpm pipeline --input pipelines/verify-session.json
```

If you want the voice first-win after the screenshot smoke:

```bash
pnpm pipeline --input pipelines/voice-hello.json
```

The browser session smoke writes `active/shared/tmp/first-win-session.png`.

After the screenshot exists, spend the remaining 10 minutes on structure:

- `pipelines/verify-session.json` shows the smallest pipeline contract that produces an artifact.
- `CAPABILITIES_GUIDE.md` shows which actuators already exist before you write new code.
- `docs/developer/EXTENSION_POINTS.md` shows how to add or stabilize an actuator, pipeline, or plugin surface.

## 3. Bring Up The Local Surfaces

```bash
pnpm agent-runtime:supervisor
pnpm mission:orchestrator
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

Useful local surfaces:

- `Chronos`: `http://127.0.0.1:3000`
- `Presence Studio`: usually `http://127.0.0.1:3031`

## 4. Use Kyberion By Asking For Outcomes

The intended interface is natural language.

Examples:

- `このPDFをパワポにして`
- `今週の進捗レポートを作って`
- `日経新聞を開いて`
- `voice-hub のログを見て`
- `今日の天気を教えて`
- `Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる`
- `スケジュールを調整して`

### How To Ask Well

Ask for the outcome first, then add only the constraints that change the result.

Good prompts usually include:

- what you want to achieve
- when or where it applies
- important constraints
- what should happen if something is missing

Examples:

- `6/6-6/8で沖縄に行くのでおすすめのホテルを探して。予算は1泊2万円前後で、那覇寄りが希望。`
- `今夜のレストランを予約したい。2名で、静かな店を優先して。`
- `この要件定義を説明する資料を作って。役員向け、10枚前後、かっちりしたトーンで。`

If the request needs clarification, Kyberion should ask for the missing inputs before proceeding.
If the request is a booking, reservation, presentation, narrated video, or another structured task, Kyberion may first create a short brief and then ask only the questions that change the outcome.
If the request is a meeting, Kyberion should first decide the role, authority boundary, and follow-up tracking plan before joining.

Kyberion should respond with one of these:

- a direct answer
- a short plan
- a request for missing information
- an approval request
- a result or artifact

## 5. What Happens Internally

You do not need to drive this manually most of the time, but this is the internal model:

1. the surface receives your intent
2. Kyberion resolves that intent
3. it creates a short plan
4. it chooses one of:
   - direct answer
   - browser/session work
   - task session
   - mission
5. it executes through actuators and ADF
6. it returns a result

Rule of thumb:

- `quick conversational work` -> answer or task session
- `larger durable work` -> mission

## 6. The Smallest Mental Model

If you only remember a few things, remember these:

1. Ask for an outcome, not a tool.
2. Kyberion will show a plan when needed.
3. Approvals appear only for risky actions.
4. Results come back as answers, artifacts, or task/mission state.
5. Missions are the durable backend model, not the primary UI.

Practical rule:

- say `ホテルを探して` rather than `booking-preference-profile を使って`
- say `説明資料を作って` rather than `presentation-preference-profile を使って`
- say `使い方の動画を作って` rather than `narrated-video-preference-profile を使って`
- say `このTeams会議を進行して` rather than `meeting-operations-profile を使って`
- say `Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる` when you want Kyberion to enter the meeting-operations path
- say `スケジュールを調整して` when you want Kyberion to enter the schedule-coordination path
- say `状態を見て` rather than `mission controller を確認して`

Kyberion will decide whether to answer directly, ask for a brief clarification, or start a task session or mission.

## 7. When To Use Each Surface

### Terminal

Use when:

- you are coding
- you want diffs, tests, and patches
- you want the fastest iteration loop

### Slack

Use when:

- you want remote conversation
- you want approvals or follow-ups in a thread
- you want results delivered back into the same thread

### Chronos

Use when:

- you want to inspect system state
- you want to understand what is running
- you need operator intervention

### Presence Studio

Use when:

- you want voice interaction
- you want conversational browser or task assistance
- you want to inspect live task details and artifacts

## 8. Reasoning Backends

If you need to understand or change which reasoning backend is used for distillation or other structured LLM work, start here:

- [`knowledge/public/governance/wisdom-policy-guide.md`](knowledge/public/governance/wisdom-policy-guide.md)

The policy guide explains:

- how `wisdom-policy.json` selects a profile
- how `adapter` maps to a runtime runner
- how to add a new local LLM without hardcoding a provider branch

## 9. Direct Operator Commands

When you need to operate internals directly:

### Health and discovery

```bash
pnpm doctor
pnpm capabilities
pnpm run cli -- list
pnpm run cli -- search browser
```

### Mission lifecycle

```bash
MC="node dist/scripts/mission_controller.js"
$MC start MY-TASK --tier confidential --persona ecosystem_architect
$MC status MY-TASK
$MC checkpoint MY-TASK step-1 "Progress note"
$MC verify MY-TASK verified "Verification summary"
$MC finish MY-TASK
```

These are operator tools.
They are not the normal end-user interface.

### Track and gate flow

```bash
pnpm control presence tracks
pnpm control chronos tracks
pnpm control chronos ref knowledge/public/templates/blueprints/requirements-traceability-matrix.md
```

Use these when you want to inspect `Project -> Track -> Gate Readiness -> Next Required Artifact` without opening a surface.

## 10. Where To Read Next

- [README.md](README.md)
- [docs/OPERATOR_UX_GUIDE.md](OPERATOR_UX_GUIDE.md)
- [docs/GLOSSARY.md](GLOSSARY.md)
- [CAPABILITIES_GUIDE.md](CAPABILITIES_GUIDE.md)
- [knowledge/public/governance/wisdom-policy-guide.md](knowledge/public/governance/wisdom-policy-guide.md)
