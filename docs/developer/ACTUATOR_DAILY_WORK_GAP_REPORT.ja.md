---
title: アクチュエータ日常運用ギャップ報告
tags: [actuators, daily-ops, gap-analysis, operator-ux]
last_updated: 2026-09-06
status: p1-implemented
---

# アクチュエータ日常運用ギャップ報告

> 英語の短い要約: [`ACTUATOR_DAILY_WORK_GAP_REPORT.md`](./ACTUATOR_DAILY_WORK_GAP_REPORT.md)
>
> 調査日: 2026-09-06 / 対象: `famaoai-creator/kyberion` `main` @ `bb69efdfc`
> 位置づけ: 証拠ベースの調査スナップショット。製品契約でも実装計画でもない。
> 技術識別子・パス・op 名は英語のまま残す。

## 0. エグゼクティブサマリ

**結論:** デスクトップ助手(Grok Bot / Cursor agent)が今日やっている日常作業を、Kyberion の **actuator 層だけで効率よく回すことは、まだ部分的にしかできない**。カタログ自体は広い(マニフェスト backed **32** 基、SaaS preset **38**)。足りないのは能力の「有無」より、**助手が1コマンド/1ツールで呼べる経路**と、**GitHub レビュー系の読み取り op** である。

| 判定                       | 内容                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| できる                     | ブラウザ RPA、画面キャプチャ、ファイル/ターミナル(secure-io 配下)、知識検索、日次 journal/TODO、会議参加・音声、承認、Chronos スケジュール                               |
| 部分的                     | GitHub(作成/マージ/Actions はある。issue/PR 一覧・レビューは無い)、Slack(経路が3つ)、メール(送信と Gmail 読取が別アクチュエータ)、カレンダー(本体と `gws`/`m365` が併存) |
| ほぼ不可(この環境)         | 公式 CLI の実行(`pnpm capabilities` / `pnpm pipeline`)。`dist/` 未生成 + Node 22(engines は `>=24`)                                                                      |
| 助手が勝っている           | GitHub PR レビュー、任意シェル、制限の少ないファイル I/O、Web 検索、サブエージェント並行                                                                                 |
| アクチュエータが勝っている | テナント隔離、承認ゲート、証跡、日次/週次の揮発メモリ、会議/音声、38 SaaS preset、Chronos                                                                                |

**P0 の形:** (1) GitHub capture op の穴埋め、(2) 助手向けの読み取り専用 `actuator`/`pipeline` 呼び出し面、(3) `dist` 無しでも発見できるオペレータ経路。詳細は §7。

### P0 実装状況(2026-09-06)

| ID   | 状態     | 入れたもの                                                                                                                                                                                                                                                                                                                         |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | **done** | `github.json` に `list_issues`, `get_issue`, `list_pulls`, `get_pull`, `list_reviews`, `list_review_comments`, `list_pr_files`。P1 で `create_review` / `create_review_comment`(apply/write/approval)を追加。harness registry 19 ops。                                                                                             |
| P0-2 | **done** | MCP `kyberion.service.capture`(capture/read のみ、承認なし)。`pipelines/daily-routine.json` を pipeline allowlist へ。書き込みは従来の `service.actuate`                                                                                                                                                                           |
| P0-3 | **done** | `pnpm capabilities` / `pnpm kyberion list` は `scripts/capability_discovery_entry.mjs` のマニフェスト走査(Node 22 でも可)。仮説「ts-loader だけで足りる」は破棄 — Node 22 に `registerHooks` が無く、`@agent/core` は dist export。実行系は引き続き `dist/` 必須。Doctor は `pnpm run doctor`(bare `pnpm doctor` は pnpm 組み込み) |
| P0-4 | **done** | [`docs/SLACK_CHANNEL_ROUTES.ja.md`](../SLACK_CHANNEL_ROUTES.ja.md)。`docs/SURFACES.md` / `CAPABILITIES_GUIDE.md` / `libs/actuators/README.md` からリンク                                                                                                                                                                           |

残り(P2+): Linux secret、アクチュエータ級 dry-run の拡張、presence multi-channel。P1 は下表。

---

## 1. 調査方法と試行結果

手を動かして確認した。推測は §8 で仮説と明示する。

### 1.1 ソース palettes

- `libs/actuators/*/manifest.json`(32、欠落ディレクトリなし)
- `CAPABILITIES_GUIDE.md`(2026-08-31、Total Actuators: 32)
- `knowledge/product/orchestration/global_actuator_index.json`
- `knowledge/product/orchestration/actuator-op-discovery.json`(生成物)
- `knowledge/product/orchestration/service-presets/*.json`(38)
- `knowledge/product/governance/mcp-tool-catalog.json`
- `package.json` scripts / `docs/SURFACES.md` / `pipelines/README.md`

### 1.2 この環境で走らせた probe

| 試行                                                              | 結果                                                         | 閉塞理由                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| マニフェスト静的走査(Node 組み込み `fs`、Kyberion runtime 非依存) | **成功**。32 基、`actuator_id` / version / public ops を取得 | —                                                                                                                                        |
| `pnpm capabilities`(`node dist/scripts/capability_discovery.js`)  | **失敗** `MODULE_NOT_FOUND`                                  | `dist/` が無い。加えて `engines.node >=24` vs 実行 Node **v22.14.0**                                                                     |
| `pnpm pipeline --input pipelines/baseline-check.json`             | **失敗** 同上                                                | `dist/scripts/run_pipeline.js` 不在                                                                                                      |
| `pnpm doctor`                                                     | **Kyberion の doctor ではない**                              | pnpm 組み込み `doctor`(registry/cache 診断)が script 名をシャドウする。正は `pnpm run doctor` → これも `dist/scripts/run_doctor.js` 依存 |
| `pnpm kyberion list` / playground / MCP server                    | 未実行                                                       | 同上(`dist/scripts/kyberion.js` 不在)                                                                                                    |
| 書き込み系 SaaS / ブラウザ実操作                                  | **意図的に未実施**                                           | 認証なし + 副作用回避                                                                                                                    |

環境メモ(2026-09-06 Cloud Agent VM):

- OS: Linux。`secret-actuator` の platforms は `darwin` / `win32` のみ → この VM では secret op は定義上利用不可
- `node_modules` は一部存在するが `libs/core/dist` も repo `dist/` も無い
- `adb` / `xcrun` / `semgrep` / `gws` / `slack-cli` / `playwright` CLI / `claude` / `grok` は PATH に無し
- `gh` は `/exec-daemon/gh` に存在する(助手側 GitHub 経路。Kyberion `service:cli` からは未配線確認)

**含意:** 「日常作業をアクチュエータで回す」最初の摩擦は、能力不足より **起動コスト**(Node 24 + `pnpm build` + 認証 + Chronos 常駐)である。これは製品ギャップというより運用ゲートだが、助手がセッション内で同じ作業を即実行できる現状との差が大きい。

---

## 2. アクチュエータ在庫

正本は各パッケージの `manifest.json`。`global_actuator_index.json` は互換スナップショット、`CAPABILITIES_GUIDE.md` は人間向け生成物([`actuator-discovery-registry.md`](../../knowledge/product/orchestration/actuator-discovery-registry.md))。

`libs/actuators/README.md` は「Core Nine」のまま(最終更新 2026-03-11)。カタログは 32。**オペレータ向け README は 0/32**。examples があるのは approval / artifact / browser / android / ios / media / media-generation / modeling / service(Backlog のみ)。

### 2.1 一覧(マニフェスト public ops)

| Actuator                     | Ver   | 目的                                | Public ops                                                                     | 契約スキーマ                              | 主な起動面                                                                                       |
| ---------------------------- | ----- | ----------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `agent-actuator`             | 1.1.0 | エージェント寿命 / A2A              | `spawn, ask, delegate, list, health, a2a, team_plan`                           | `agent-action.schema.json`                | mission / pipeline                                                                               |
| `android-actuator`           | 1.1.0 | ADB + Android CLI                   | `pipeline`                                                                     | `mobile-device-pipeline.schema.json`      | pipeline / examples                                                                              |
| `approval-actuator`          | 1.1.0 | 人の承認状態機械                    | `create, load, decide, list_pending, evaluate_decision_rights, request_review` | `approval-action.schema.json`             | CLI `approvals` / MCP / pipeline                                                                 |
| `artifact-actuator`          | 1.0.0 | 成果物・delivery pack               | `write_json, read_json, append_event, write_delivery_pack`                     | `artifact-action.schema.json`             | pipeline                                                                                         |
| `blockchain-actuator`        | 1.1.0 | ローカル台帳アンカー(**simulated**) | `anchor_mission, anchor_trust, verify_anchor`                                  | `blockchain-action.schema.json`           | pipeline。`verify_anchor` は未実装注記あり                                                       |
| `browser-actuator`           | 1.1.0 | Playwright RPA / セッション証跡     | `pipeline, computer_interaction`                                               | `browser-automation-pipeline.schema.json` | pipeline / examples。内部 ~56 step ops                                                           |
| `build-actuator`             | 1.0.0 | iOS/Android ビルド                  | `scaffold_app, ios_*, android_*`                                               | `build-pipeline.schema.json`              | CLI / pipeline。Xcode / `ANDROID_HOME`                                                           |
| `calendar-actuator`          | 1.2.0 | Calendar.app JXA + GWS              | `list_calendars, list_events, query_freebusy, create_event`                    | `calendar-action.schema.json`             | `pnpm kyberion calendar` / pipeline                                                              |
| `code-actuator`              | 2.2.0 | コード解析 / Semgrep                | `pipeline, semgrep_scan, reconcile, impact_analysis`                           | `code-pipeline.schema.json`               | pipeline。`bin:semgrep`                                                                          |
| `deployment-actuator`        | 1.0.0 | 配備境界                            | `deploy_release`                                                               | `deployment-action.schema.json`           | pipeline。承認ゲート                                                                             |
| `email-actuator`             | 1.2.0 | 下書き/送信(Mail.app / SMTP)        | `create_draft, send, send_from_file`                                           | アクチュエータ内 schema                   | `pnpm kyberion email` / `email:workflow`。**受信なし**。`create_draft` は darwin                 |
| `file-actuator`              | 1.1.0 | ガバナンス下ファイル I/O            | `pipeline`                                                                     | `file-pipeline.schema.json`               | pipeline。内部 21 ops(`read/write/search/…`)                                                     |
| `ingest-actuator`            | 1.2.0 | 文書 → knowledge card               | `sync_source, parse_document, normalize_card, dedup, staleness_report, commit` | **manifest に未宣言**                     | `pnpm ingest` / pipeline                                                                         |
| `ios-actuator`               | 1.1.0 | iOS Simulator                       | `pipeline`                                                                     | `mobile-device-pipeline.schema.json`      | **darwin only**                                                                                  |
| `media-actuator`             | 1.2.0 | PPTX/DOCX/XLSX / digest             | `pipeline`                                                                     | `media-pipeline.schema.json`              | pipeline / examples                                                                              |
| `media-generation-actuator`  | 1.2.0 | 生成 + 画面キャプチャ               | `generate_*, capture_*, record_screen, pipeline, …`(12)                        | `media-generation-action.schema.json`     | pipeline / generation schedule                                                                   |
| `meeting-actuator`           | 1.2.0 | Meet/Zoom/Teams 抽象                | `join, leave, speak, listen, chat, status`                                     | `meeting-action.schema.json`              | `pnpm meeting:participate` / `meeting:run`                                                       |
| `meeting-browser-driver`     | 1.0.0 | Playwright join ドライバ            | `join, leave`                                                                  | **未宣言**                                | meeting-actuator 内部。将来シーム: `zoom-sdk`, `recall-ai`([`docs/SURFACES.md`](../SURFACES.md)) |
| `modeling-actuator`          | 1.0.0 | アーキテクチャ ADF                  | `pipeline, reconcile`                                                          | `modeling-pipeline.schema.json`           | pipeline                                                                                         |
| `network-actuator`           | 2.2.0 | 安全 fetch / A2A                    | `pipeline`                                                                     | `network-pipeline.schema.json`            | pipeline                                                                                         |
| `orchestrator-actuator`      | 1.0.0 | ミッション分解/実行計画             | `pipeline, reconcile`                                                          | `orchestrator-pipeline.schema.json`       | mission / pipeline                                                                               |
| `presence-actuator`          | 1.0.0 | 人への配信                          | `dispatch, receive_event, dispatch_timeline`                                   | `presence-action.schema.json`             | pipeline。外部は **Slack のみ** + log fallback                                                   |
| `process-actuator`           | 1.0.0 | プロセス寿命                        | `spawn, stop, list, status`                                                    | `process-action.schema.json`              | supervisor                                                                                       |
| `secret-actuator`            | 1.1.0 | OS 秘密管理                         | `get, set, delete, list`                                                       | `secret-action.schema.json`               | pipeline。**linux なし**                                                                         |
| `service-actuator`           | 1.3.0 | SaaS/API/MCP 到達                   | `pipeline, api, cli, preset, mcp, reconcile, oauth`                            | `service-action.schema.json`              | pipeline / MCP `service.actuate`                                                                 |
| `system-actuator`            | 1.6.0 | OS 診断 / 入力 / baseline           | 26 public ops。内部 ~78                                                        | `system-pipeline.schema.json`             | `baseline-check` / doctor / pipeline                                                             |
| `terminal-actuator`          | 1.0.0 | PTY                                 | `spawn, poll, write, kill, computer_interaction`                               | `terminal-action.schema.json`             | computer-surface / pipeline                                                                      |
| `video-composition-actuator` | 1.1.0 | ナレーション動画束                  | 9 ops                                                                          | **未宣言**                                | pipeline                                                                                         |
| `vision-actuator`            | 1.4.0 | 画像理解 facade                     | `inspect_image, ocr_image, describe_image`                                     | `vision-action.schema.json`               | pipeline。生成/キャプチャは media-generation へ                                                  |
| `voice-actuator`             | 1.6.0 | ローカル TTS/録音                   | 12 ops                                                                         | `voice-action.schema.json`                | presence-studio / `voice:*` CLI                                                                  |
| `wisdom-actuator`            | 1.6.0 | 知識・判断・互換 forwarder          | 81 ops                                                                         | `wisdom-action.schema.json`               | pipeline。新規は owner actuator を使え(CAPABILITIES_GUIDE 注記)                                  |
| `working-memory-actuator`    | 1.2.0 | MEMORY/NOW/journal/TODO             | 15 ops                                                                         | `working-memory-action.schema.json`       | `pipelines/daily-routine.json`                                                                   |

発明していない。上記はツリー上の 32 のみ。

### 2.2 登録 / 発見 / ディスパッチ

```text
libs/actuators/*/manifest.json          ← 正本(スキャン: libs/core の actuator-manifest-index)
        │
        ├─ scripts/sync_component_inventory.ts → global_actuator_index.json + CAPABILITIES_GUIDE.md
        └─ describeOps() in src/op-catalog.ts
                │
                └─ pnpm generate:op-registry
                        ├─ knowledge/product/governance/actuator-op-registry.json
                        └─ knowledge/product/orchestration/actuator-op-discovery.json
```

実行時:

1. パイプライン step の `op` は `domain:action`(例: `working-memory:daily-open`, `service:preset`)
2. `resolveActuatorOperation` → `dist/libs/actuators/<id>/src/index.js`
3. `actuator.dispatch` またはレガシー `handleAction`(`libs/core/actuator-sdk.ts`)

**ビルド必須。** `pnpm kyberion run` も `dist/` の entry を探す(`scripts/cli.ts` `resolveActuatorPath`)。無いと「Run `pnpm build` first」。

単発 op 試験は `scripts/actuator_playground.ts`(`--dry-run` あり)だが **package.json script が無い**。

---

## 3. 起動面(誰がどう呼ぶか)

| 面                 | コマンド / 入口                                                    | アクチュエータへの到達                                              |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Pipeline(本命)** | `pnpm pipeline --input <json>`                                     | `domain:action` を全カタログへ。dry-run はパイプライン層に存在      |
| **統合 CLI**       | `pnpm kyberion list\|info\|search\|run\|schedule\|email\|calendar` | `run` はアクチュエータ CLI 全体。op ルータではない                  |
| **Capabilities**   | `pnpm capabilities` / `pnpm kyberion list --check`                 | 発見とバイナリ probe。実行しない                                    |
| **MCP(Cowork)**    | `pnpm mcp:server`                                                  | 発見 + allowlist 8 本 + `service.actuate`(承認・operator・既定オフ) |
| **Mission**        | `pnpm mission …`                                                   | 直接 op CLI は無い。タスクが pipeline / agent を呼ぶ                |
| **TUI**            | `pnpm tui`                                                         | 監視/操作。生 op REPL ではない                                      |
| **Chronos**        | `pnpm chronos` + `pnpm daemon:watchdog`                            | `schedule.cron` 付き pipeline を 60s tick                           |
| **Satellite**      | Slack / Telegram / Discord / iMessage                              | 会話入口。アクチュエータ本体ではない                                |
| **Playground**     | `pnpm exec tsx scripts/actuator_playground.ts`                     | 単発 op。未 script 化                                               |

MCP pipeline allowlist(`mcp-tool-catalog.json`):

- `pipelines/list-capabilities.json`
- `pipelines/knowledge-sync.json`
- `pipelines/vital-check.json`
- `pipelines/system-diagnostics.json`
- `pipelines/inspect-workspace-surfaces.json`
- `pipelines/inspect-network-environment.json`
- `pipelines/baseline-check.json`
- `pipelines/cowork-integration-review.json`

**日常運用の `daily-routine` / email triage / GitHub は allowlist 外。** `kyberion.capability.search` は説明だけ返す。

---

## 4. 日常作業カバレッジマップ

凡例: **A** = アクチュエータで実用 / **P** = 部分 / **S** = satellite・別レイヤ / **X** = 実質なし / **H** = 助手(Cursor/Grok)の方が今は速い

| 日常作業                       | 判定 | Kyberion 側                                                                                                                | 助手が今日やっていること                        | 差                                                      |
| ------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| GitHub issue 作成/更新/閉じる  | A    | `service:preset` `github`                                                                                                  | GitHub MCP `issue_write`                        | 同等だが承認ゲート分だけ遅い                            |
| GitHub PR 作成/マージ          | A    | `create_pull_request`, `merge_pull_request`                                                                                | `ManagePullRequest` / MCP                       | 同等(書き込み)                                          |
| GitHub issue/PR **一覧・取得** | P/X  | preset に `list_issues` / `get_issue` / `list_pulls` **なし**。template `github-issue-ingest.json` は `service:cli` + `gh` | MCP `list_*` / `search_*` / `pull_request_read` | **助手が明確に勝つ**                                    |
| GitHub **レビュー**            | X    | preset に review/comment-on-review なし                                                                                    | pending review + line comments                  | **最大ギャップの一つ**                                  |
| GitHub Actions 状態            | A    | `actions_list_runs`, `actions_get_run`                                                                                     | MCP `pull_request_read` / `gh run`              | アクチュエータで足りる                                  |
| Slack 送信                     | P    | `service:preset` `post_message` / presence `dispatch` / slack-bridge                                                       | このセッションに Slack MCP なし                 | 経路が3つで迷う                                         |
| Slack 履歴読取                 | P    | `conversations_history` / `conversations_replies`                                                                          | —                                               | ingest 連携は別作業                                     |
| Telegram / Discord / iMessage  | S    | satellite + 一部 preset(Discord/Telegram REST)                                                                             | 通常なし                                        | アクチュエータ単体では会話ループにならない              |
| ドキュメント生成(PPTX/DOCX)    | A    | `media-actuator`                                                                                                           | 手書き Markdown が主                            | Kyberion が厚い                                         |
| 知識検索 / org memory          | A    | `wisdom:knowledge_*`, ingest, working-memory, MCP `knowledge.search`                                                       | repo Grep/Read(隔離なし)                        | ガバナンスは Kyberion                                   |
| メール下書き/送信              | P    | `email-actuator`(送信) + `google-workspace` `gmail_*` + `pnpm kyberion email`                                              | 通常なし                                        | 受信と送信が分裂                                        |
| カレンダー読取/作成            | P    | `calendar-actuator` + GWS/M365 preset + `pnpm kyberion calendar`                                                           | 通常なし                                        | template が `calendar:*` ではなく `shell` で CLI を叩く |
| ブラウザ RPA / スクショ        | A    | `browser-actuator` + `media-generation` capture + `system:record_screen`                                                   | ブラウザツール / RecordScreen                   | 証跡付きなら Kyberion                                   |
| シェル                         | A    | `terminal-actuator`, `system` exec, `wisdom:shell`                                                                         | 任意 Shell                                      | 助手が速い。Kyberion は PTY/監督付き                    |
| ローカルファイル               | A    | `file-actuator`(secure-io)                                                                                                 | Read/Write ほぼ自由                             | 意図的に狭い                                            |
| 秘密情報                       | P    | `secret-actuator`(darwin/win32)                                                                                            | 環境の資格情報 / MCP auth                       | **Linux 日常は空**                                      |
| スケジュール / watchdog        | A    | Chronos, `daily-routine`, `weekly-review`, `daemon:watchdog`                                                               | タイマー MCP(任意)                              | Kyberion が本命                                         |
| ダイジェスト                   | P    | `weekly-executive-digest`(入力フィクスチャ)、`daily-summary`(capabilities 件数)                                            | 助手がその場で要約                              | **GitHub/Slack 日次 digest は無い**                     |
| 会議参加 / 議事録              | A    | `meeting-actuator`, `minutes:record`, `meeting:participate`                                                                | 通常なし                                        | 環境(Playwright/マイク)依存                             |
| 音声 TTS/STT                   | A    | `voice-actuator`                                                                                                           | 通常なし                                        | ローカル音声スタック依存                                |
| モバイル実機                   | P    | android/ios/build                                                                                                          | 通常なし                                        | darwin / SDK 前提                                       |

### 4.1 service-actuator が今日届く SaaS

`knowledge/product/orchestration/service-presets/`(38):
asana, aws-ce, backlog, box, brave-search, canva, cloudflare, comfyui, confluence, discord, figma, gemini, **github**, **github-mcp**, gitlab, google-maps, **google-workspace**, jira, linear, **m365**, media-generation, meeting, notion, paper2any, **slack**, smoke-test, sqlite, stripe, telegram, video-analysis, vision, voice, voice-local, whisper, x-docs, xapi, youtube, zendesk。

`github-mcp.json` は `@modelcontextprotocol/server-github` の **3 op**(search_repositories / get_file_contents / create_issue)だけ。Cursor 側 GitHub MCP の PR/review 面とは別物で、**更新遅れ**に見える。

---

## 5. 代表タスクの具体経路(今日オペレータが踏む道)

4 本。いずれも「 theoretically 存在する道」と、この VM で止まるとこを分ける。

### 5.1 朝の journal / TODO 繰り越し

**意図:** 今日の日記面と TODO を開き、昨日の未完了を繰り越す。

**今日の正経路:**

```bash
# 前提: Node >=24 && pnpm install && pnpm build
# 任意: Chronos 常駐( cron 0 6 * * * Asia/Tokyo )
pnpm chronos

# 手動再実行
pnpm pipeline --input pipelines/daily-routine.json
```

中身([`pipelines/daily-routine.json`](../../pipelines/daily-routine.json)):

1. `working-memory:daily-open` → journal / TODO 面
2. `working-memory:todo-rollover`
3. `system:write_artifact` → `active/shared/tmp/daily-routine-summary.md`

**摩擦:**

- MCP allowlist に無いので Cowork/助手から直接回せない
- 成果は tmp 要約。Slack/メール配信は別配線
- この VM では `pnpm pipeline` が `dist` 不足で即死
- テナント/個人スコープの journal 実体は volatile knowledge 計画側(`docs/VOLATILE_KNOWLEDGE_PLAN.ja.md`)

**助手が今やること:** その場でメモを書く。繰り越し・面の正準化・6:00 起動は無い。

### 5.2 GitHub「この PR/issue の状態は?」

**意図:** レビュー待ち PR、CI、issue コメントを読む。必要ならレビューを書く。

**経路 A — service preset(アクチュエータ本命だが穴がある):**

```json
{
  "op": "service:preset",
  "params": {
    "service_id": "github",
    "action": "actions_list_runs",
    "params": { "owner": "…", "repo": "…" }
  }
}
```

実装済み: `create_issue`, `update_issue`, `add_comment`, `close_issue`, `list_repos`, `actions_*`, `create_pull_request`, `merge_pull_request`。
**無い:** `list_issues`, `get_issue`, `list_pulls`, `get_pull`, `list_reviews`, `create_review`, ファイル一覧、検索。

**経路 B — `gh` CLI を service:cli で包む:**

[`github-issue-ingest.json`](../../knowledge/product/pipeline-templates/github-issue-ingest.json) は `service:cli` `gh issue list --label mission`。ラベル付き issue → mission という特殊系。PR レビュー用テンプレは見当たらない。

**経路 C — MCP:**

- Kyberion: `kyberion.service.actuate`(high risk、approval、operator、confidential/personal、**既定オフ**)
- Cursor GitHub MCP: この調査セッションでは PR/issue/review を直接呼べる

**摩擦:** 日常の「PR を読んでコメントする」はアクチュエータ preset だけでは閉じない。助手は MCP を使い、Kyberion 経路はパイプラインを新しく書くか `gh` を shell する。後者は「アクチュエータ経由で効率よく」にならない。

**この VM:** GitHub 読み取りは助手 MCP で可能。Kyberion preset 実行は build + token 不足で未実施。

### 5.3 毎朝のメール仕分け

**意図:** 未読を要約し、返信下書きを作り、送信は承認。

**今日の正経路:**

1. シナリオ: [`knowledge/product/task-scenarios/daily-email-triage.json`](../../knowledge/product/task-scenarios/daily-email-triage.json)(平日 8:00 JST)
2. テンプレをテナントへコピー: [`email-triage-workflow.json`](../../knowledge/product/pipeline-templates/email-triage-workflow.json)
3. `gws` 認証(`google-workspace` `gmail_triage`)
4. 送信が要れば `pnpm kyberion email deliver` / `email-actuator` + 承認

```bash
pnpm kyberion email status
pnpm services:setup
# tenant copy of email-triage-workflow.json
pnpm pipeline --input knowledge/confidential/<tenant>/pipelines/email-triage-workflow.json
```

**摩擦:**

- `email-actuator` は **送信専用**。受信は `service-actuator` + `gws`
- template README はテナント複製 + preflight を要求
- `create_draft`(Mail.app)は darwin
- MCP から回せない
- この VM に `gws` も SMTP も無い

### 5.4 ブラウザでページを見てスクショする

**意図:** URL を開き、DOM を残し、スクショし、必要なら Playwright テストを書き出す。

**今日の正経路:**

```bash
pnpm build
# 例: libs/actuators/browser-actuator/examples/explore-and-export.json
# example.com へ goto → snapshot → content → screenshot → export_playwright
pnpm kyberion run browser-actuator -- --input libs/actuators/browser-actuator/examples/explore-and-export.json
# または pipeline step "op": "browser:pipeline"
```

成果物パス例: `active/shared/tmp/browser/explore-example-com.png`。

代替: `media-generation:capture_screen` / `system:record_screen` / `computer_interaction`(browser/system/terminal)。

**摩擦:**

- Playwright ランタイムと display。headless ならサーバでも可だが未検証
- `kyberion run` はアクチュエータ CLI 全体。単発 `screenshot` は playground か pipeline JSON
- examples/README はあるがアクチュエータ本体 README は無い
- この VM では Playwright CLI 無し + `dist` 無し

### 5.5 (参考) Slack へ「今日の要約」を送る

経路が3つあり、オペレータ文書が一本化されていない:

| 経路           | 使うもの                                             | 向き                                     |
| -------------- | ---------------------------------------------------- | ---------------------------------------- |
| Satellite      | `satellites/slack-bridge` + surface runtime          | 双方向会話・承認スレッド                 |
| Presence       | `presence:dispatch`(Slack binding が無いと log-only) | 一方的通知                               |
| Service preset | `service:preset` `slack` `post_message`              | API 投稿。履歴は `conversations_history` |

`daily-summary` template は `pnpm capabilities` と mission 件数を `system:shell` で数えるだけで、Slack には送らない。

---

## 6. ギャップ分析

### 6.1 助手ができるがアクチュエータが弱い / 無い

| 能力                      | 助手                  | アクチュエータ                                     | 影響                                     |
| ------------------------- | --------------------- | -------------------------------------------------- | ---------------------------------------- |
| PR 差分を読んで行コメント | GitHub MCP review 面  | GitHub preset に review op なし                    | 日常のレビュー作業が Kyberion に乗らない |
| issue/PR 検索・一覧       | あり                  | `list_repos` と書き込み中心                        | 「朝の inbox」が組めない                 |
| 任意リポジトリ編集        | Read/Write/StrReplace | `file-actuator` + `code-actuator`(secure-io / ADF) | 速さは助手。再現性は Kyberion            |
| Web 検索                  | WebSearch             | `brave-search` / `network:fetch`                   | preset はあるが助手は即時                |
| サブエージェント並行      | Task ツール           | `agent-actuator` spawn/delegate                    | 配線はあるが起動コストが高い             |
| Linux の秘密              | 環境資格              | secret-actuator 対象外                             | Cloud / Linux 日常が空                   |

### 6.2 アクチュエータがあるが助手がまだ使っていない

| 能力                | アクチュエータ            | なぜ助手は使わないか                       |
| ------------------- | ------------------------- | ------------------------------------------ |
| 日次 journal / TODO | working-memory            | MCP/CLI から単発で呼びにくい。allowlist 外 |
| 文書 ingest → card  | ingest-actuator           | 儀式(`commit`)とテナントスコープが重い     |
| 会議参加・議事録    | meeting / voice / minutes | マイク・ブラウザ・同意が要る               |
| カレンダー/メール   | calendar / email / gws    | 認証とホスト(macOS / gws)依存              |
| 承認・監査          | approval / audit MCP      | デスクトップ助手は PR 上で完結しがち       |
| Chronos 定期実行    | scheduler + watchdog      | 助手はセッション寿命                       |
| 38 SaaS preset      | service-actuator          | `service.actuate` が既定オフ               |
| 判断支援 81 ops     | wisdom-actuator           | 非 stub backend 必須。forwarder はレガシー |

### 6.3 重複 vs 統合機会

| 重複              | 中身                                                         | 提案の方向                                                                     |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| GitHub 4 経路     | REST preset / 古い github-mcp / `gh` CLI / Cursor GitHub MCP | REST を「日常 capture」まで広げ、MCP は薄い facade に                          |
| Slack 3 経路      | satellite / presence / preset                                | 役割を SURFACES に明記。通知は preset、会話は satellite                        |
| カレンダー 3 経路 | calendar-actuator / gws / m365                               | CLI(`kyberion calendar`)を唯一の人入口に。template の `shell` 呼び出しをやめる |
| メール 2 経路     | email-actuator vs gmail_*                                    | 受信=service、送信=email、をオペレータ1枚に                                    |
| ファイル/シェル   | file / system / terminal / wisdom                            | CAPABILITIES_GUIDE の互換注記どおり owner を使う                               |
| 画面キャプチャ    | media-generation / system / browser                          | 既存 facade(vision が生成を委譲したのと同じ)                                   |

### 6.4 「効率よく回せるか」への直接回答

| 問い                                 | 答え                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| カタログは日常を覆うか               | **型としては覆う。** 会議・音声・知識・スケジュールは助手より厚い                              |
| 助手の今の仕事をそのまま置換できるか | **GitHub レビューとアドホック編集は否。** それ以外はパイプライン化できるが初回コストが高い     |
| 効率のボトルネックは                 | (1) 助手向け実行 API が無い (2) GitHub capture 欠落 (3) build/Node/認証ゲート (4) 経路の多重化 |

---

## 7. Brush-up 推奨(優先度つき)

P0 と P1 は実装済み(上表および下表)。P2 は形だけ残す。

### P1 実装状況(2026-09-06)

| ID                         | 状態     | 入れたもの                                                                                                                                                                                                                                                    |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 leftover / review write | **done** | REST `github.json` に `create_review`, `create_review_comment`。`kind=apply` / `risk=write` / `approval_required`。capture 面は拒否                                                                                                                           |
| P1-1                       | **done** | `knowledge/product/pipeline-templates/daily-github-inbox.json`。`list_issues` / `list_pulls` / `actions_list_runs` でローカル digest。Slack `post_message` はテンプレに含めず(承認/write ゲートのまま)。`schedule.enabled=false` + README に Chronos 登録手順 |
| P1-2                       | **done** | `docs/EMAIL_OPERATOR.ja.md`。`pnpm kyberion email` をオペレータ面、`email-actuator` は配送、Gmail/gws は読取と明記。CLI help / `email-workflow` usage を更新                                                                                                  |
| P1-3                       | **done** | `package.json` に `playground` / `actuator:playground` → `tsx scripts/actuator_playground.ts`。`--dry-run --json` で単発発見                                                                                                                                  |
| P1-4                       | **done** | `schedule-summary-and-coordination.json` v3。`calendar:list_calendars` / `calendar:list_events`。`node dist/.../calendar-actuator` の shell を削除                                                                                                            |
| P1-5                       | **done** | `github-mcp.json` を deprecated external-MCP example として残す。正本は REST `github`。MCP `create_issue` を apply/write に直し(以前は method 無しで capture と誤分類)。テスト用 3 op は維持                                                                  |
| P1-6                       | **done** | `libs/actuators/README.md` の Core Nine を削除し CAPABILITIES_GUIDE / `pnpm capabilities` / `pnpm playground` へリダイレクト                                                                                                                                  |
| P1-7                       | **done** | `kyberion:doctor` は既存。OPERATOR_UX / INITIALIZATION / CLI help / kyberion_cli_entry で `pnpm run doctor` を強制。first-win 契約の `pnpm doctor` 文言は維持(契約テスト固定)                                                                                 |

### P0 — 日常がアクチュエータに乗らない直接因

| ID   | 推奨                                    | なぜ日常に効く                                                                    | 形                                                                                                                                                                                                 |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | GitHub preset に **capture 一式**を足す | 朝の PR/issue inbox と CI 確認が `service:preset` だけで閉じる                    | `github.json` + harness registry に `list_issues`, `get_issue`, `list_pulls`, `get_pull`, `list_review_comments`, `list_pr_files`。書き込みの review 投稿は承認付きで P1                           |
| P0-2 | 助手向け **読み取り実行面**             | 今の MCP は発見と診断8本だけ。助手は結局 GitHub MCP / 生シェルに逃げる            | 案A: MCP pipeline allowlist に `daily-routine` と read-only GitHub 診断を追加。案B: `kyberion.actuator.run` を **capture-only / 承認不要 / allowlist op** で新設。書き込みは現行 `service.actuate` |
| P0-3 | `dist` 無しでも発見できるオペレータ経路 | Cloud / 新品 checkout で `pnpm capabilities` が即死すると「使えない」と誤認される | `capability_discovery` を `ts-loader` 経由の script にする、または `pnpm kyberion list` をソース実行可能に。最低限ドキュメントに「build が必要」を CAPABILITIES_GUIDE 先頭へ                       |
| P0-4 | Slack 経路の1枚図                       | 通知が log-only に落ちたり、bridge と preset を二重投稿する                       | `docs/SURFACES.md` か OPERATOR_UX に「会話=satellite / 投稿=preset / タイムライン=presence」                                                                                                       |

### P1 — 乗せるための糊

| ID   | 推奨                                       | なぜ                                                                                                                                                                                                                  | 形                                                                                                      |
| ---- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| P1-1 | 日次 GitHub/Slack digest テンプレ          | 助手が毎朝やってる要約を Chronos に移す                                                                                                                                                                               | `knowledge/product/pipeline-templates/daily-github-inbox.json`(P0-1 前提) + Slack `post_message` は承認 |
| P1-2 | メール受信/送信のオペレータ1枚             | triage が gws、送信が email-actuator で迷子                                                                                                                                                                           | `pnpm kyberion email` に inbox/triage を寄せ、email-actuator は配送専用と明記                           |
| P1-3 | `pnpm playground`                          | 単発 op 試験が隠れていて助手が pipeline JSON を書きがち                                                                                                                                                               | `package.json` に `actuator_playground.ts` を出す                                                       |
| P1-4 | カレンダー template を `calendar:*` に直す | [`schedule-summary-and-coordination.json`](../../knowledge/product/pipeline-templates/schedule-summary-and-coordination.json) が `shell` で `node dist/.../calendar-actuator` を呼ぶ。LAYERED_EXECUTION_PLAN に反する | step を `calendar:list_calendars` / `calendar:list_events` に                                           |
| P1-5 | `github-mcp` preset の更新か削除           | 3 op の古い `@modelcontextprotocol/server-github` は Cursor GitHub MCP と重複し、誤誘導                                                                                                                               | 現行 REST preset を正にし、MCP preset は「外部 MCP を叩く例」か退役                                     |
| P1-6 | アクチュエータ README の世代更新           | `libs/actuators/README.md` の Core Nine は 32 基と矛盾                                                                                                                                                                | 生成するか CAPABILITIES_GUIDE へリダイレクト                                                            |
| P1-7 | `pnpm doctor` の名前衝突                   | 本調査で pnpm 組み込み doctor が実行された                                                                                                                                                                            | script を `kyberion:doctor` にするか、文書で `pnpm run doctor` を強制                                   |

### P2 — 環境と周辺

| ID   | 推奨                                       | なぜ                                            | 形                                                                        |
| ---- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| P2-1 | Linux secret backend                       | Cloud Agent / Linux 日常で secret-actuator が空 | libsecret / file+chmod は仮説。まずは「未対応」を capabilities で赤く出す |
| P2-2 | アクチュエータ級 dry-run                   | pipeline dry-run と playground `--dry-run` だけ | capture は常に dry、apply は `--dry-run` で契約検証のみ                   |
| P2-3 | presence の multi-channel                  | dispatch が Slack 固定                          | 新アクチュエータは作らず、satellite へ forward する port                  |
| P2-4 | meeting の zoom-sdk / recall-ai            | SURFACES が「未実装シーム」と明記               | シームのまま。日常は browser-playwright                                   |
| P2-5 | この種の Cloud 環境の Node 24 + 事前 build | 公式 probe が全部死ぬ                           | environment build。製品コードではない                                     |

---

## 8. 仮説と事実の境界

**事実(ツリー / この VM で確認):**

- マニフェスト backed アクチュエータは 32。欠落ディレクトリなし
- GitHub REST preset は 10 op。list/get issue・list/get PR・review はファイル内に存在しない
- MCP `pipeline_run_allowlist` は 8 本。日常 pipeline は含まれない
- `secret-actuator` platforms に linux が無い
- `email-actuator` に受信 op が無い
- `presence-actuator` の外部メッセージは Slack(なければ log)
- この VM で `pnpm capabilities` / `pnpm pipeline` は `dist` 不足で失敗
- `pnpm doctor` は pnpm 組み込みにシャドウされた

**仮説(未検証、実装前に再確認):**

- H1: GitHub capture を足せば、助手の朝会作業の過半は `service:preset` パイプラインに移せる
- H2: MCP に capture-only `actuator.run` を足す方が、allowlist 増殖より安全(書き込みは既存ゲート)
- H3: `github-mcp.json` は現行 GitHub MCP ツール名と一致していない
- H4: Linux secret を足さなくても、Cloud では外部 secret store + env で足りる可能性がある
- H5: schedule-summary の `shell` ラップは、当時 `calendar:*` が pipeline registry に無かった名残

---

## 9. 参照(この報告が踏んだパス)

- カタログ: `libs/actuators/*/manifest.json`, `CAPABILITIES_GUIDE.md`, `libs/actuators/README.md`
- 発見: `knowledge/product/orchestration/actuator-discovery-registry.md`, `scripts/generate_op_registry.ts`, `libs/core/actuator-sdk.ts`, `libs/core/actuator-op-registry.ts`
- 起動: `scripts/cli.ts`, `scripts/actuator_playground.ts`, `package.json`
- MCP: `knowledge/product/governance/mcp-tool-catalog.json`
- SaaS: `knowledge/product/orchestration/service-presets/github.json`, `github-mcp.json`, `slack.json`, `google-workspace.json`, `service-harness-registry.json`
- 日常: `pipelines/daily-routine.json`, `knowledge/product/pipeline-templates/daily-summary.json`, `email-triage-workflow.json`, `github-issue-ingest.json`, `schedule-summary-and-coordination.json`, `weekly-executive-digest.json`
- 面: `docs/SURFACES.md`, `docs/OPERATOR_UX_GUIDE.md`, `pipelines/README.md`

---

## 10. 成功条件への自己点検

| 要求             | この文書                      |
| ---------------- | ----------------------------- |
| 在庫             | §2。32 基。発明なし           |
| カバレッジマップ | §4                            |
| 試した経路       | §1.2(probe) + §5(4+1 本)      |
| ギャップ         | §6                            |
| 優先 brush-up    | §7 P0–P2                      |
| 実パス根拠       | 各節のファイルパス。推測は §8 |
