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
pnpm build
pnpm onboard
pnpm surfaces:reconcile
```

## 2. Bring Up The Local Surfaces

```bash
pnpm agent-runtime:supervisor
pnpm mission:orchestrator
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm chronos:dev
```

Useful local surfaces:

- `Chronos`: `http://127.0.0.1:3000`
- `Presence Studio`: usually `http://127.0.0.1:3031`

## 3. Use Kyberion By Asking For Outcomes

The intended interface is natural language.

Examples:

- `このPDFをパワポにして`
- `今週の進捗レポートを作って`
- `日経新聞を開いて`
- `voice-hub のログを見て`
- `今日の天気を教えて`

Kyberion should respond with one of these:

- a direct answer
- a short plan
- a request for missing information
- an approval request
- a result or artifact

## 4. What Happens Internally

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

## 5. The Smallest Mental Model

If you only remember a few things, remember these:

1. Ask for an outcome, not a tool.
2. Kyberion will show a plan when needed.
3. Approvals appear only for risky actions.
4. Results come back as answers, artifacts, or task/mission state.
5. Missions are the durable backend model, not the primary UI.

## 6. When To Use Each Surface

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

## 7. Direct Operator Commands

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

## 8. Where To Read Next

- [README.md](/Users/famao/kyberion/README.md)
- [docs/OPERATOR_UX_GUIDE.md](/Users/famao/kyberion/docs/OPERATOR_UX_GUIDE.md)
- [docs/GLOSSARY.md](/Users/famao/kyberion/docs/GLOSSARY.md)
- [CAPABILITIES_GUIDE.md](/Users/famao/kyberion/CAPABILITIES_GUIDE.md)
