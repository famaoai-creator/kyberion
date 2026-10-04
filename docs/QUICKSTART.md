# Quick Start

**Start here.** This page is the single front door to Kyberion; every other guide (README, [INITIALIZATION](./INITIALIZATION.md), [user docs](./user/README.md), [HOWTO](./HOWTO.md), [developer tour](./developer/TOUR.md)) either points back to it or goes deeper after it. **Just want to run something?** → Run the five commands in [§2 First Win Smoke](#2-first-win-smoke). This is the canonical first-win command order. The broader documentation source map is [`documentation-source-map.json`](./documentation-source-map.json).

Looking for a command? The generated [CLI Reference](./CLI_REFERENCE.md) lists every command; task-oriented notes for the everyday ones are in the [Commands Guide](./user/COMMANDS_GUIDE.md).

New to the vocabulary? Read [CORE_CONCEPTS](./CORE_CONCEPTS.md) first — the 5 concepts you need (work, pipeline, capability, tenant/tier, surface).

---

Kyberion should be approached as a request-driven system.

Start with:

```text
Intent -> Plan -> Result
```

The system keeps internal runtime detail behind that conversation.

At every step it makes the request, plan, result, and next action visible.

## 1. Setup

> This document is the canonical first-win source. The full onboarding order after first-win — readiness, identity, getting the baseline to `all_clear`, and the optional tenant / organization / activation steps — is in the [onboarding standard flow](../knowledge/product/governance/onboarding-flow.md). Command-by-command detail is in [INITIALIZATION.md](./INITIALIZATION.md).
>
> Pick a route first: **personal only** (no tenant; stop after the baseline is `all_clear`), **AI company** (`pnpm onboarding company`, below), or **add an existing tenant** (standard flow Steps 5–8).

Prerequisites:

- Node.js `24+` (matches `package.json` engines and `.nvmrc`)
- `pnpm`

Get the code first:

```bash
git clone https://github.com/famaoai-creator/kyberion.git
cd kyberion
```

The canonical first-win command sequence is deliberately short:

<!-- kyberion-first-win -->

```bash
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm kyberion doctor
pnpm pipeline --input pipelines/verify-session.json
```

`env:bootstrap` verifies the Node 24+ floor and warns if Playwright browsers are missing. Use `pnpm kyberion doctor` for the readiness check: bare `pnpm doctor` is pnpm's own built-in diagnostic and does not run Kyberion's checks.

### Day-2 setup: AI company, tenant activation (optional)

Skip this subsection for a first look — the first-win smoke in §2 needs none of it. Come back when you want a governed company, tenant or customer context.

#### Start an AI company in one governed step

For a solo founder whose main workforce is AI, run the company onboarding flow after the build:

```bash
pnpm onboarding company --vertical saas-product-company --slug acme-ai \
  --name "ACME AI" --owner-id human:founder \
  --goal "Define the first customer outcome and launch plan" --dry-run
pnpm onboarding company --vertical saas-product-company --slug acme-ai \
  --name "ACME AI" --owner-id human:founder \
  --goal "Define the first customer outcome and launch plan"
```

`pnpm onboarding` uses `customer/{slug}/ preferred when KYBERION_CUSTOMER is set` for the customer stance overlay.

The dry-run shows the write scope and next commands without changing files. The applied flow creates the customer overlay, binds the accountable human, registers the initial AI worker and approval boundaries, and writes a first-work plan that remains paused until human review. Add `--tenant-slug <tenant>` when the tenant profile is known; the flow will then create or reuse the organization context binding. Tenant activation is still a separate human-accepted gate.

When `KYBERION_CUSTOMER` is set, `customer/{slug}/` is preferred for customer-specific identity and onboarding artifacts.

Before starting the first work, activate the tenant after the readiness probes, then review its management unit:

```bash
pnpm tenant:activation activate \
  --customer-slug acme-ai --tenant-slug <tenant> --organization-id acme-ai \
  --owner-id human:founder --nhi-id <nhi-id> \
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
pnpm onboarding apply --identity knowledge/public/templates/onboarding/identity.example.json --dry-run
```

Copy the template, edit it, and rerun without `--dry-run` when you are ready to apply it.

### Onboarding entry points

Several commands and pipelines carry "onboarding" in their name. They are not alternatives for the same job; pick by what you want to achieve.

| Entry point                                                    | What it does                                                                                                                                                                   | Use it when                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install` ... `pipelines/verify-session.json` (§2)        | The first-win smoke: install, build, doctor, one browser artifact.                                                                                                             | First run on a new machine. Needs no identity or tenant.                                                                                         |
| `pnpm kyberion setup report --persona first-time-user`         | Read-only readiness report across surfaces, services, reasoning and doctor.                                                                                                    | After the first win, or whenever something feels unusable.                                                                                       |
| `pnpm kyberion setup <area>`                                   | One short route into each setup tool: `onboarding`, `context`, `reasoning`, `env`, `services`, `tools`, `provider-cli`, `agy-sdk`, `voice`, `config`.                          | You know which area needs work. `pnpm kyberion setup` lists the areas; the table is in the [CLI Reference](./CLI_REFERENCE.md#scopes-and-areas). |
| `pnpm onboarding` (wizard; the old name `onboard` still works) | Interactive identity wizard: name, language, vision, Agent ID, service connection candidates. Flags: `--express`, `--menu`, `--reconfig`, `--services-only`, `--service <id>`. | Saving your identity (standard flow Step 3). Run `pnpm stance:switch <slug>` first when acting as a customer.                                    |
| `pnpm onboarding apply --identity <json> [--dry-run]`          | The same identity written from a JSON file, without prompts.                                                                                                                   | Non-interactive hosts and CI. Copy the template under `knowledge/public/templates/onboarding/`.                                                  |
| `pnpm onboarding company ...` (and `company bootstrap`)        | Starts an AI company in one governed step: customer overlay, accountable human, first AI worker, paused first-work plan. Always try `--dry-run` first.                         | You are a solo founder whose workforce is AI (route 2 of the standard flow).                                                                     |
| `pnpm onboarding reset`                                        | Deletes onboarding state and the generated identity / vision / agent files of the active profile.                                                                              | You want to start the identity step over.                                                                                                        |
| `pnpm onboarding:context` (`show`, `bind`, `first-work`)       | Binds a tenant to an organization context and prepares the first work item. Read-only unless `--apply`.                                                                        | You work with tenants (routes 2 and 3). Also reachable as `pnpm kyberion setup context`.                                                         |
| `pipelines/launch-first-run-onboarding.json`                   | Writes a canned identity input under `active/shared/tmp/` and applies it through `onboarding apply`. Deterministic, no questions asked.                                        | Demos and automated first-run checks. Not for a real identity.                                                                                   |
| `pipelines/kyberion-autonomous-onboarding.json`                | Mines the environment and codebase, interviews you about knowledge sources, and proposes integrations and a profile. Run it explicitly; `pnpm onboarding` does not start it.   | After the identity exists and you want Kyberion to find your information assets.                                                                 |
| `pipelines/platform-onboarding.json`                           | Organization-integration flow: discovery transcript, requirements draft, design spec, test plan, task plan. Task execution runs in downstream pipelines.                       | Taking on a customer integration engagement, not setting up your own machine.                                                                    |
| `pipelines/voice-onboarding.json`                              | Records three reference voice samples, registers the voice profile, makes a short preview, grants per-mission voice consent. `dry_run=true` only validates.                    | You want Kyberion to speak in a registered voice. Check devices with `pnpm kyberion doctor --scope voice` first.                                 |

The order of the steps, and which route you need, is canonical in the [onboarding standard flow](../knowledge/product/governance/onboarding-flow.md); the command-by-command detail is in [INITIALIZATION](./INITIALIZATION.md).

## 2. First Win Smoke

If you only want the shortest path to a visible result, start here.

The first-win path is intentionally staged:

- 30 seconds: `pnpm kyberion doctor` shows whether the local runtime is ready and what value boundary is currently blocked
- 60 seconds: `pnpm kyberion setup report --persona first-time-user` tells you which surface to use next and whether auth/setup is still blocking it
- 5 minutes: `pnpm pipeline --input pipelines/verify-session.json` writes `active/shared/tmp/first-win-session.png`
- optional voice path: `pnpm pipeline --input pipelines/voice-hello.json`
- on-demand pull: `pnpm deps:check --actuator browser|voice|media-generation` checks actuator-level dependencies before you start that surface
- 15 minutes: skim sections 4-10, then open `pipelines/verify-session.json`, `CAPABILITIES_GUIDE.md`, and `docs/developer/EXTENSION_POINTS.md` to understand the structure

```bash
pnpm kyberion doctor
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

After the install and full build in §1, run this from the repository root. The managed runtime starts the enabled local surfaces together; a development server for one UI does not start the others.

<!-- kyberion-managed-startup -->

```bash
set -e
export KYBERION_LOCALHOST_AUTOADMIN=true
pnpm surfaces reconcile
pnpm surfaces status
pnpm kyberion setup report --persona first-time-user
```

`KYBERION_LOCALHOST_AUTOADMIN=true` grants loopback callers `localadmin` for the local UI APIs. Use it only on a trusted local machine; remote/shared deployments need an explicit viewer identity and scope (see [viewer-scope operations](./developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md)). Set it before starting the managed surfaces so the child processes inherit it.

Wait for a surface's health to become `healthy` in `pnpm surfaces status` before opening it. A `started` result or an enabled manifest is not a readiness check. If a surface is still starting, rerun status; if it fails, follow its diagnostic and targeted repair command rather than starting a second server on the same port. For example: `pnpm surfaces repair --surface concierge`, then check status again.

Choose the surface for the task (full role map: [SURFACES](./SURFACES.md)):

- **Make a request, review a decision, or receive a deliverable:** Concierge at `http://127.0.0.1:3050`. Start here for everyday work. Complete the profile in Settings when prompted, then describe the outcome you want.
- **Inspect a runtime or investigate a failure:** Chronos at `http://127.0.0.1:3000`.
- **Try voice and live transcripts:** Presence Studio at `http://127.0.0.1:3031`, with a healthy `voice-hub` and the voice prerequisites reported by `pnpm kyberion doctor --runtime voice`.
- **Use a terminal control view:** `pnpm tui`.

These are the default registry URLs. The setup report probes the configured local endpoints and gives one next step for the Concierge request flow. If you changed ports, use the report and manifest values. A healthy UI confirms reachability; individual requests still check their own permissions and service requirements.

External messaging bridges such as Slack are optional and disabled by default. Their missing credentials do not block local Concierge use, and `reconcile` deliberately skips disabled surfaces. Set up a bridge only when you need that channel; inspect `pnpm surfaces setup`, then explicitly opt in with `pnpm surfaces enable --surface slack-bridge` once its prerequisites are ready.

Do not launch `pnpm agent-runtime:supervisor` or `pnpm mission:orchestrator` as startup daemons. They are one-shot workers that require a `--request` or `--event` payload; managed execution dispatches them as needed. `pnpm chronos:dev` is for developing Chronos alone and is not the complete startup path.

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

### Or use one command per sense

From a terminal you can skip the conversation and use a single verb (Markdown on stdout, `--json` for structure). Copy external files into `active/shared/tmp/<job>/` first.

| You have                        | Command                         |
| ------------------------------- | ------------------------------- |
| a PDF / PPTX / DOCX / XLSX      | `pnpm kyberion read <file>`     |
| an image                        | `pnpm kyberion see <image>`     |
| audio                           | `pnpm kyberion listen <audio>`  |
| a video                         | `pnpm kyberion watch <video>`   |
| a brief to turn into a document | `pnpm kyberion write ...`       |
| a prompt to turn into an image  | `pnpm kyberion draw ...`        |
| text to be spoken               | `pnpm kyberion speak ...`       |
| a request in plain words        | `pnpm kyberion ask "<request>"` |

`pnpm kyberion` with no arguments shows a status digest and your next action. Details: [`capability-verb-inventory`](../knowledge/product/orchestration/capability-verb-inventory.md).

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

### Terminal (`pnpm kyberion`, `pnpm tui`)

Use when:

- you live in a shell and want a status digest plus your next action (`pnpm kyberion`)
- you want the verbs above, approvals (`pnpm kyberion approvals`) or the inbox
- you want a resident cockpit for missions and work items (`pnpm tui`)

### Capture pads (`pnpm pads`)

Use when:

- you have something on your desk — a sketch, meeting notes, a screenshot, a file, the clipboard, today's TODO
- you want it captured locally (127.0.0.1 only) and handed off, without anything being sent or started on its own

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

- you want the front desk for asking (頼む), following progress (進み具合) and today's briefing (ホーム)
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
pnpm kyberion doctor
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
- [docs/CLI_REFERENCE.md](./CLI_REFERENCE.md) — every command, generated from the command manifest
- [docs/user/COMMANDS_GUIDE.md](./user/COMMANDS_GUIDE.md) — task-oriented notes for the everyday commands
- [docs/user/](./user/README.md) — task-first guides and [troubleshooting](./user/TROUBLESHOOTING.md)
- [docs/SURFACES.md](SURFACES.md)
- [docs/COMPONENT_MAP.md](COMPONENT_MAP.md)
- [docs/OPERATOR_UX_GUIDE.md](OPERATOR_UX_GUIDE.md)
- [docs/GLOSSARY.md](GLOSSARY.md)
- [CAPABILITIES_GUIDE.md](../CAPABILITIES_GUIDE.md)
- [knowledge/product/governance/wisdom-policy-guide.md](../knowledge/product/governance/wisdom-policy-guide.md)
