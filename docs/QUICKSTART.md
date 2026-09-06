# Quick Start

**Just want to run something?** → Run the five commands in [§2 First Win Smoke](#2-first-win-smoke). This is the canonical first-win command order. The broader documentation source map is [`documentation-source-map.json`](./documentation-source-map.json).

---

Kyberion should be approached as a request-driven system.

Start with:

```text
Intent -> Plan -> Result
```

The system keeps internal runtime detail behind that conversation.

At every step it makes the request, plan, result, and next action visible.

## 1. Setup

> This document is the canonical first-win source. Day-2 tenant / organization / activation work is in [INITIALIZATION.md](./INITIALIZATION.md), and the operational lifecycle is in the [onboarding standard flow](../knowledge/product/governance/onboarding-flow.md).

Prerequisites:

- Node.js `24+` (matches `package.json` engines and `.nvmrc`)
- `pnpm`

The canonical first-win command sequence is deliberately short:

# kyberion-first-win

```bash
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm doctor
pnpm pipeline --input pipelines/verify-session.json
```

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain     # verifies Node 24+ floor; warns if Playwright browsers are missing
pnpm doctor
pnpm pipeline --input pipelines/verify-session.json
```

### Start an AI company in one governed step

For a solo founder whose main workforce is AI, run the company onboarding flow after the build:

```bash
pnpm onboard company --vertical saas-product-company --slug acme-ai \
  --name "ACME AI" --owner-id human:founder \
  --goal "Define the first customer outcome and launch plan" --dry-run
pnpm onboard company --vertical saas-product-company --slug acme-ai \
  --name "ACME AI" --owner-id human:founder \
  --goal "Define the first customer outcome and launch plan"
```

`pnpm onboard` uses `customer/{slug}/ preferred when KYBERION_CUSTOMER is set` for the customer stance overlay.

The dry-run shows the write scope and next commands without changing files. The applied flow creates the customer overlay, binds the accountable human, registers the initial AI worker and approval boundaries, and writes a first-work plan that remains paused until human review. Add `--tenant-slug <tenant>` when the tenant profile is known; the flow will then create or reuse the organization context binding. Tenant activation is still a separate human-accepted gate.

When `KYBERION_CUSTOMER` is set, `customer/{slug}/` is preferred for customer-specific identity and onboarding artifacts.

Before starting the first work, activate the tenant after the readiness probes, then review its management unit:

```bash
pnpm tenant:activation activate \
  --customer-slug acme-ai --tenant-slug <tenant> --organization-id acme-ai \
  --nhi-id <nhi-id> \
  --check-viewer-scope --check-nhi --check-services --check-isolation \
  --probe-ref viewer_scope=<audit-ref> \
  --probe-ref nhi_provisioned=<audit-ref> \
  --probe-ref service_readiness=<audit-ref> \
  --probe-ref isolation_probe=<audit-ref> \
  --apply --accept
```

```bash
pnpm onboarding:context first-work --customer-slug acme-ai \
  --intent "Define the first customer outcome and launch plan" --dry-run --json
```

If you already have an onboarding payload, use Path B instead of the wizard:

```bash
pnpm onboard apply --identity knowledge/public/templates/onboarding/identity.example.json --dry-run
```

Copy the template, edit it, and rerun without `--dry-run` when you are ready to apply it.

## 2. First Win Smoke

If you only want the shortest path to a visible result, start here.

The first-win path is intentionally staged:

- 30 seconds: `pnpm doctor` shows whether the local runtime is ready and what value boundary is currently blocked
- 60 seconds: `pnpm kyberion setup report --persona first-time-user` tells you which surface to use next and whether auth/setup is still blocking it
- 5 minutes: `pnpm pipeline --input pipelines/verify-session.json` writes `active/shared/tmp/first-win-session.png`
- optional voice path: `pnpm pipeline --input pipelines/voice-hello.json`
- on-demand pull: `pnpm deps:check --actuator browser|voice|media-generation` checks actuator-level dependencies before you start that surface
- 15 minutes: skim sections 4-10, then open `pipelines/verify-session.json`, `CAPABILITIES_GUIDE.md`, and `docs/developer/EXTENSION_POINTS.md` to understand the structure

```bash
pnpm doctor
pnpm kyberion setup report --persona first-time-user
pnpm pipeline --input pipelines/verify-session.json
```

If you want the voice first-win after the screenshot smoke:

```bash
pnpm pipeline --input pipelines/voice-hello.json
```

The browser session smoke writes `active/shared/tmp/first-win-session.png`.
If browser launch is blocked, the pipeline now automatically falls back to `active/shared/tmp/first-win-fallback.txt`.

If the smoke fails because a surface looks stale or a permission is missing, open [docs/user/TROUBLESHOOTING.md](./user/TROUBLESHOOTING.md) and run `pnpm surfaces repair` or `pnpm kyberion setup report --persona first-time-user` before retrying.

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

Useful local surfaces (full role map: [`docs/SURFACES.md`](./SURFACES.md)):

- `Chronos`: `http://127.0.0.1:3000` (control tower)
- `Concierge`: `http://127.0.0.1:3050` (CEO secretary — requests, approvals, deliverables)
- `Presence Studio`: usually `http://127.0.0.1:3031`
- `Terminal HUD`: `pnpm tui` (Ink TUI for missions / work items / runtimes)

Chronos API routes resolve a viewer principal server-side; `KYBERION_LOCALHOST_AUTOADMIN=true` grants loopback callers `localadmin` (see `docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`).

If you are unsure which one matters for your goal, `pnpm kyberion setup report --persona first-time-user` is the canonical entry guide:

- `Chronos` for runtime visibility and operator control
- `Concierge` for the "what should I decide now" secretary view
- `Presence Studio + voice-hub` for conversational voice/browser demos
- `Slack` when you want threaded remote interaction and auth is ready

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

All of this sits inside one containment chain, widest first: a **tenant** (a confidentiality boundary) contains an **organization** (how that entity runs), which contains a **project** (a long-lived container of meaning), which contains **missions** and their tasks. Every work item carries that chain as typed context (`tenant_slug → organization_id → project_id → mission_id → task_id` plus a `work_shape`), so the same work shows up consistently in the Organization, Home, Work Items, Operations, Missions, and Governance views. Routine operations, incidents, and cadences — work that is not a solution project — are tracked by the organization operating model (`pnpm organization`).

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

The canonical role map (with ports and write scopes) is [`docs/SURFACES.md`](./SURFACES.md). Summary:

### Concierge

Use when:

- you want the secretary view: pending requests, approvals, deliverables, exceptions
- you are deciding, not operating

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

- [`knowledge/product/governance/wisdom-policy-guide.md`](../knowledge/product/governance/wisdom-policy-guide.md)

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
pnpm run kyberion -- list
pnpm run kyberion -- search browser
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

- [README.md](../README.md)
- [docs/SURFACES.md](SURFACES.md)
- [docs/COMPONENT_MAP.md](COMPONENT_MAP.md)
- [docs/OPERATOR_UX_GUIDE.md](OPERATOR_UX_GUIDE.md)
- [docs/GLOSSARY.md](GLOSSARY.md)
- [CAPABILITIES_GUIDE.md](../CAPABILITIES_GUIDE.md)
- [knowledge/product/governance/wisdom-policy-guide.md](../knowledge/product/governance/wisdom-policy-guide.md)
