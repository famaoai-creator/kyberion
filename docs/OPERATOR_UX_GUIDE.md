# Operator UX Guide

Kyberion has a rich internal model, but the operator UX should still be easy to explain:

```text
Intent -> Plan -> State -> Result
```

This guide explains how to operate Kyberion without forcing people to think in raw pipelines, runtime registries, or actuator contracts first.

Surface map: [`docs/SURFACES.md`](./SURFACES.md).

For enterprise role separation above the operator layer, also read:

- `knowledge/product/architecture/enterprise-operating-kernel.md`
- `knowledge/product/architecture/ceo-ux.md`
- `knowledge/product/architecture/management-control-plane.md`
- `knowledge/product/architecture/surface-responsibility-model.md`

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

Default operator phrasing should stay plain:

- `短い作業として進めます。`
  - when the request stays bounded and does not need mission governance
- `承認と記録が必要なためミッションとして進めます。`
  - when the request needs durable ownership, approval, or audit evidence
- `この文章は、文章種別 / レビュー目的 / 役割 / テナントを確認してから見ます。`
  - when the user asked for review and the source kind or reviewer context matters

For mission-backed work, the team composition artifact also carries a small governance block:

- `team_governance.lifecycle`
  - bounds on team size, turn budget, message budget, and wall-clock budget
  - shutdown and resume policy for handoff-safe operation
- `team_governance.composition`
  - which roles are required, optional, assigned, or still unfilled

This is what makes mission staffing explainable before delegation begins.

When resuming a mission, the operator should expect the controller to rebuild state from the journal first:

- `mission_controller resume <MISSION_ID>`
  - replays the orchestration journal to find the next event
  - logs `journal から再開: 次イベント=... / 回収タスク=... 件`
  - logs `lease 回収: requested=... / waiting=... / reissued=...`
  - keeps `LATEST_TASK.json` as a human-facing warning about the last intended physical action

The resume path is now mechanically driven. The warning remains as context, not as the primary recovery mechanism.

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

Slack threads should be read as incoming conversation turns, not as the operator's request by default.
If the speaker is someone other than the operator, Kyberion should preserve that speaker identity and keep the reply authority separate from the mission owner.

### Chronos Mirror

Use when you want:

- operator visibility
- runtime and mission state
- intervention points
- delivery inspection
- project, track, gate, and mission-seed control

Chronos is the control surface.
It explains and intervenes, but it does not replace the durable control plane.

### Concierge (秘書室)

Use when you want (as the CEO / sovereign):

- 本日のブリーフィング(何件の承認・依頼・成果・例外があるか)
- ご承認待ちの判断(承認する / 差し戻す)
- お届けした成果の受領・修正依頼・差し戻し
- 通常フローから外れた例外の確認

The concierge is the executive secretary (`http://127.0.0.1:3050`,
`presence/displays/concierge`). It never shows execution machinery —
only decisions and outcomes, in polite Japanese.

### Presence Studio

Use when you want:

- conversational interaction
- hands-free or voice interaction
- 会議の録音 → 自動議事録(「会議を記録」ボタン / `pnpm minutes:record --mission <ID>`)
- browser assistance
- live task detail and artifact access
- immediate project bootstrap context

Presence Studio is the companion workbench (相棒).

For hands-free dictation on macOS, use `system:voice_input_toggle` as the fallback when browser-based capture is unavailable or the focused app expects the OS dictation shortcut. That keeps the shortcut in the OS-control layer instead of mixing it into `voice-actuator`.

### Background Bridges

Use `pnpm prereq:check` first when you want to confirm the local toolchain needed to build and run Kyberion from source. Then use `pnpm surfaces:setup` when you want to confirm which credentials, CLI fallbacks, or host permissions are missing. After that, use `pnpm surfaces:reconcile` when you want Kyberion to bring managed bridges and surfaces up to the manifest-defined state.

Use `pnpm services:setup` when you want the external service catalog to tell you which presets still need customer/personal connection files or authentication secrets. Use `pnpm reasoning:setup` when you want the reasoning backend decision to be explicit before `doctor` or `env:bootstrap` runs. The reasoning setup now distinguishes `claude-cli`, `anthropic`, `codex-cli`, `gemini-cli`, `nemotron-api`, `local`, and `stub`, so OpenAI-compatible Nemotron endpoints are visible before bootstrap chooses a backend.

Use `pnpm setup:report` when you want a consolidated readiness view across surfaces, services, reasoning, and doctor without checking each domain one by one.

`pnpm doctor` includes the baseline runtime and reasoning backend manifest checks; use it when you want the consolidated readiness view rather than a domain-specific setup report.

`pnpm doctor` also reports the pipeline schedule registry maintained by Chronos. For the volatile memory layer, expect these scheduled entries after `node dist/scripts/chronos_daemon.js` has started at least once:

| Schedule                |          Cadence | Purpose                                                                                                                    |
| ----------------------- | ---------------: | -------------------------------------------------------------------------------------------------------------------------- |
| `volatile-gc-daily`     |  Daily 04:00 JST | Expire and roll over volatile working-memory faces.                                                                        |
| `storage-janitor-daily` |  Daily 04:30 JST | Run governed TTL cleanup for tmp, logs, data-vault, and runtime retention directories.                                     |
| `volatile-index-daily`  |  Daily 05:00 JST | Rebuild the volatile knowledge index.                                                                                      |
| `daily-routine`         |  Daily 06:00 JST | Open daily journal/TODO and roll over pending items.                                                                       |
| `weekly-review`         | Monday 07:00 JST | Open weekly review, nominate promotion candidates, write task-model routing stats, and summarize queued memory candidates. |
| `mesh-delivery-5min`    |  Every 5 minutes | Drive queued Mesh Hub deliveries (claim → dispatch → ack/retry/dead-letter). Requires `KYBERION_MESH_PEER_ID`.             |

Typical managed entries include:

- `slack-bridge`
- `imessage-bridge`
- `discord-bridge`
- `telegram-bridge`
- `chronos-mirror-v2`
- `nexus-daemon`
- `terminal-bridge`

Typical service presets include:

- `google-workspace`
- `github`
- `slack`
- `notion`
- `jira`

Use `pnpm surfaces:setup` to inspect auth readiness, `pnpm surfaces:status` to inspect state, and `pnpm surfaces:start -- --surface <surface-id>` or `pnpm surfaces:stop -- --surface <surface-id>` for a specific managed surface.

Use `pnpm surfaces:repair -- --surface <surface-id>` when a surface is tracked but unhealthy or stale and you want Kyberion to restart it without doing a full reconcile.

### Voice Onboarding

Use this when you want to register a new operator voice profile before meeting work:

1. Run `pnpm meeting:preflight`.
   - If it fails, fix the reported browser, BlackHole, mlx-audio, voice-consent, or reasoning backend gap first.
2. Dry-run the onboarding flow with `pnpm pipeline --input pipelines/voice-onboarding.json --context '{"dry_run":true}'`.
   - If dry-run fails, rerun `pnpm meeting:preflight` and inspect the failing step output.
3. Run the real onboarding flow with `pnpm pipeline --input pipelines/voice-onboarding.json --context '{"mission_id":"MSN-...","operator_handle":"<handle>"}'`.
   - The pipeline records three samples, registers the profile, renders a trial clip to `active/shared/tmp/voice-onboarding-check.wav`, and registers voice consent for the active mission.
4. Verify the result with `pnpm meeting:consent status --mission MSN-...`.
   - If consent is missing, rerun the onboarding pipeline with the correct mission ID.

### 会議→価値提供 実行手順

1. 事前前提をまとめて確認する。

```bash
pnpm meeting:preflight
```

失敗したら `pnpm doctor:meeting --mission MSN-...` を先に実行し、表示された `fix` を直してからやり直す。

2. 初回だけ voice profile と consent をまとめて作る。

```bash
pnpm pipeline --input pipelines/voice-onboarding.json --context '{"mission_id":"MSN-...","operator_handle":"<handle>"}'
```

失敗したら `pnpm meeting:preflight` を再実行し、`pnpm meeting:consent status --mission MSN-...` で consent が有効か確認する。

3. 会議ミッションを作る。

```bash
pnpm mission create MSN-... --mission-type meeting_facilitation --tenant-slug <slug> --persona <handle>
```

失敗したら `--tenant-slug` の形式と `pnpm mission create --help` の引数を確認し、テナント境界を直してからやり直す。

4. 会議に参加する。

```bash
pnpm meeting:participate \
  --mission MSN-... \
  --meeting-url "https://meet.google.com/..." \
  --platform meet \
  --display-name "Kyberion (operator delegate)"
```

失敗したら `pnpm doctor:meeting --mission MSN-...` を再実行し、ブラウザ・音声・consent の欠落を先に解消する。

5. 会議後フォローアップで議事録と action items を作る。

```bash
pnpm pipeline --input pipelines/meeting-followup.json --context '{"mission_id":"MSN-...","transcript_path":"<meeting:participate の完了ログで出た transcript_path>","attendees":[{"name":"Alice"},{"name":"Bob"},{"name":"Operator"}],"operator_label":"Operator","language":"ja"}'
```

失敗したら transcript の実パスと reasoning backend を見直し、必要なら `pnpm meeting:preflight` からやり直す。

6. customer 提供まで finish する。

```bash
KYBERION_CUSTOMER=<slug> pnpm mission finish MSN-...
```

失敗したら `KYBERION_CUSTOMER` と `--tenant-slug` を一致させ、`customer/<slug>/` が存在することを確認してから finish を再実行する。

For Google Workspace email and Meet work:

- `pnpm email:workflow status`
  - check the shared Gmail auth status from CLI
- `pnpm email:workflow draft --triage-file active/shared/tmp/email-inbox-triage.md`
  - generate a reply draft from CLI using the same shared core as Web
- `pnpm email:workflow deliver --draft-mode --body-file <path>`
  - create a Gmail draft from CLI without sending
- `gws auth login --services gmail --readonly`
  - use for inbox triage and read-only inspection
- `gws auth login --services gmail`
  - use for reply draft creation and send actions
- If `gws auth login` reports `No OAuth client configured`, provide one of:
  - `/Users/famao/.config/gws/client_secret.json`
  - `GOOGLE_WORKSPACE_CLI_CLIENT_ID` and `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET`
  - `gws auth setup --project <gcp-project-id> --login` when `gcloud` is available
- `gws auth status`
  - confirm the credential state before sending mail
- `gws meet spaces create --json '<payload>'`
  - create a Google Meet space with the authenticated Google account
- `gws schema meet.spaces.create`
  - inspect the exact request shape before creating a Meet space
- `pnpm gws:meet:create -- --json '{}'`
  - Kyberion wrapper for creating a Google Meet space from the terminal

### Email Triage Quick Start

Use this when you want the shortest path from inbox triage to a sent reply.

#### Web

1. Open Presence Studio.
2. Check `Gmail auth status`.
3. Use `Create Reply Draft` to generate the reply text.
4. Review it in `Send Approved Email` and send only after confirmation.

#### CLI

1. Run `pnpm cli -- email status`.
2. Run `pnpm cli -- email draft --triage-file active/shared/tmp/email-inbox-triage.md`.
3. Inspect the latest output with `pnpm cli -- email latest-draft`.
4. Create a Gmail draft with `pnpm cli -- email deliver --draft-mode --body-file <path>`.
5. Add `--approved` only when you really want to send it.

#### Notes

- Shared logic lives in `libs/core/email-workflow.ts`.
- Web and CLI both use the same email workflow core.
- Sending should always happen after a visible confirmation step.

The lifecycle details live in [`knowledge/product/architecture/runtime-surface-lifecycle-model.md`](../knowledge/product/architecture/runtime-surface-lifecycle-model.md).

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
- `この文章をレビューして`
  - Kyberion first identifies the data type, review purpose, reviewer role, and tenant context, then asks only the missing review questions before it proceeds
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
- team assembly with lifecycle guardrails

For distillation and other structured reasoning tasks, see:

- [`knowledge/product/governance/wisdom-policy-guide.md`](knowledge/product/governance/wisdom-policy-guide.md)

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

- connection material goes in the active private overlay: `customer/{slug}/connections/` when `KYBERION_CUSTOMER` is set, otherwise `knowledge/personal/connections/`
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

### Customer engagement (deals)

```bash
pnpm kyberion deals                          # 商談一覧(全テナント、stage 付き)
pnpm kyberion deals --requirements DEAL-XXXX # 要件ヒアリングで収集済みの構造化ドラフト
```

顧客チャネル(`customer/<tenant>/connections/channel-bindings.json`)に紐づく会話は
deal stage に応じて自動でモードが切り替わる: 営業(inquiry〜contract)/
要件ヒアリング(discovery — 構造化ドラフトを増分収集)/ サポート(won 以降 —
`knowledge/confidential/<tenant>/support/known-issues.md` を接地)。binding の
`"mode"` で固定も可能。能動送信は常に承認ゲート経由。

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
cat knowledge/product/governance/wisdom-policy.json
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

## 11. アプリ開発ライフサイクルの回し方(E2E-05)

iOS/Android アプリの AI-DLC/SDLC を回す標準手順(コピペ可):

```bash
# 0. 前提チェック(配布まで見るなら --full)
pnpm app:preflight --platform android        # or ios / all

# 1. code_change ミッションを作成(レビュー必須クラス)
pnpm mission create --type code_change --goal "FixtureApp にログイン機能を追加"

# 2. SDLC 取り込み: 意図 → 要件 → 設計 → タスク分解 → NEXT_TASKS → テスト計画
pnpm pipeline --input pipelines/sdlc-cycle.json \
  --context '{"mission_id":"MSN-XXXX","project_name":"FixtureApp","intent_text":"ログイン機能を追加したい。..."}'

# 3. 実装(orchestration worker が E2E-03 の協調 — PR 協調・review 往復 — で回す)
pnpm mission start MSN-XXXX

# 4. 新規アプリなら scaffold(fixture 方式、外部ツール不要)
echo '{"op":"scaffold_app","platform":"android","app_name":"FixtureApp","bundle_id":"dev.example.fixture","dest_dir":"active/shared/tmp/fixture-app"}' > /tmp/build-input.json
node dist/libs/actuators/build-actuator/src/index.js --input /tmp/build-input.json

# 5. ビルド / テスト(ログは evidence/build/ に全量)
echo '{"op":"android_build","project_dir":"active/shared/tmp/fixture-app","mission_id":"MSN-XXXX"}' > /tmp/build-input.json
node dist/libs/actuators/build-actuator/src/index.js --input /tmp/build-input.json

# 6. デバイステスト: test-plan(test-case-adf)→ device pipeline へコンパイル
#    modeling-actuator op: test_inventory_to_device_pipeline (platform: android|ios)

# 7. ベータ配布(fastlane 委譲・approval-gate 必須)
#    knowledge/personal/deployments/<project>.json に:
#    {"adapter":"mobile-beta","platform":"android","project_dir":"active/shared/tmp/fixture-app"}
```

補足: iOS は `ios_generate_project`(xcodegen)→ `ios_build`。実機/シミュレータ検証は `KYBERION_MOBILE_TOOLCHAIN=1 pnpm vitest run tests/app-lifecycle-e2e.test.ts`。
