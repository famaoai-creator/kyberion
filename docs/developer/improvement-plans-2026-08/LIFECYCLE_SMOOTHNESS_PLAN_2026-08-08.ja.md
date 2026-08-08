---
title: Lifecycle Smoothness Plan 2026-08-08
tags: [onboarding, lifecycle, organization, mission, schedule, operations, continuous-improvement]
last_updated: 2026-08-08
status: phase4-in-progress
---

# ライフサイクル円滑化計画(オンボーディング → 運用 → 持続的改善)

## 1. 背景

Kyberion のライフサイクルは「オンボーディング(persona 登録・identity 登録・外部サービス設定・モデル選択)→ 組織・プロジェクト・サービス・組織目標の設定 → ミッション/タスクによる活動 → スケジュールタスクの実施 → レビューと持続的改善 → 日常運用」という一連の流れを想定している。

2026-08-08 に、この経路全体を read-only 実地監査で検証した(baseline-check 実行、オンボーディング/組織・プロジェクト/ミッション・タスク/スケジュール・運用の 4 領域を並行監査)。結論は次の一文に要約できる。

> **各段の構造(state machine・ゲート・レジストリ)はほぼ実装済みだが、「段と段の接続」と「無人での運転」が欠けており、ライフサイクルは一度も通しで完走していない。**

本計画は置き換え計画ではない。既存の onboarding wizard、organization operating model、mission controller、chronos スケジューラ、feedback loop をそのまま活かし、**接続部と運転部**を埋める計画である。

## 2. 検証結果(エビデンス)

### 2.1 ライフサイクル段ごとの現状

| 段                            | 状態                                                                                                                                                                                              | 一次エビデンス                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| baseline-check                | `all_clear`(ただしインフラ健全性のみ。下記の停止をどれも検出しない)                                                                                                                               | `run_baseline_check.js` 実行結果                                                                                           |
| オンボーディング              | **未完走**: `draft phase=identity` のまま。接続 0 ready / 4 blocked(comfyui・whisper・voice・meeting)、テナント 0、チュートリアル未開始                                                           | `pnpm dashboard:onboarding` 出力                                                                                           |
| モデル(reasoning backend)選択 | 検出のみで**選択が永続化されない**。`claude` CLI は repo 内 placeholder が本物(`~/.local/bin/claude` 2.1.226 認証済み)を PATH で隠し、毎回 unavailable 警告 → 無言フォールバック                  | `scripts/onboarding_wizard.ts:491-566` / `libs/core/shell-claude-cli-backend.ts:599-708` / `node_modules/.bin/claude` shim |
| 組織・目標・サービス登録      | **書き込み系ファサードが存在しない**。core の writer(`saveOrganizationPurpose` 等)はテストからしか呼ばれない。実在する唯一の組織 state は `sample_fixture: true` のフィクスチャ。OKR 0 objectives | `scripts/organization_operating_model.ts:117-133` / `libs/core/organization-operating-model.ts:1033,1133`                  |
| プロジェクト                  | `pnpm project` は CRUD 完備だが**組織と接続されない**(create に organization/context フラグなし、`active_project_ids` を書くコマンドなし)。管理プロジェクト 5 件はどれも組織未所属                | `scripts/project_controller.ts:53-57` / `libs/core/organization-operating-model.ts:1941-1953`                              |
| ミッション/タスク             | 237 ミッション中 **158 件が実質放置**(active 100 + distilling 58、最古は 3 月)。hygiene は `planned` しか掃かない。`--HELP` `--ID` というCLI誤パース起源のゴミミッションが 2 tier に残存          | `pnpm mission list` / `hygiene` 出力                                                                                       |
| typed context chain           | 不変条件は「作成時に typed `context`」だが、`pnpm work create-item` に context 系フラグが**存在せず**、mission dispatcher 自身も metadata 経由で運んでいる                                        | `scripts/work_coordination.ts:147-163` / `libs/core/mission-ticket-dispatch.ts:337-356`                                    |
| スケジュールタスク            | **chronos-daemon が 2026-08-02 から死んだまま 6 日間、25 宣言スケジュール中 0 件発火**。heartbeat 監視・launchd/cron 常駐化・死亡アラートなし。15/25 は一度も実行歴なし、4 件は failed のまま放置 | `active/shared/runtime/heartbeats/chronos-daemon.json`(pid 消滅)/ `pipeline-schedules.json`                                |
| 通知                          | `ops-alerts.jsonl` 669 件中 **553 件が `operator_notification_undelivered`(no_channel_configured)**。webhook 未設定のため全て pull 依存                                                           | `libs/core/ops-alert.ts:58`                                                                                                |
| 持続的改善ループ              | 構造的には閉じている(trace → hints → 次回 intent 注入)が、auto-learned hints は全件「Step X produced a file artifact…」の定型文(confidence 0.5 固定)で**信号ゼロ**                                | `libs/core/src/feedback-loop.ts:43-135` / `feedback-loop/hints/auto-learned.json`                                          |
| 運用サーフェス                | UI サーフェス(chronos-mirror-v2:3000 / concierge:3050 / operator-surface:3331 ほか)は enabled 宣言にもかかわらず**全ポート無応答**。`pnpm surfaces:status` は policy ロード以外**何も出力しない** | `lsof` / `pnpm surfaces:status` 実行結果                                                                                   |

### 2.2 診断:3 つの構造欠陥

1. **完走したことがない First-Win 経路** — オンボーディングは identity phase で止まり、組織 authoring は CLI が無く、唯一の組織はフィクスチャ。下流(project 所属・OKR・work_shape 分類)はすべて空のまま動いている。
2. **無人運転の不在** — スケジューラ・サーフェス・通知のどれも常駐化/監視されておらず、死んでも誰にも(baseline-check にすら)見えない。「動いているように見える」のはエージェントセッションが起動時に baseline-check を叩いて鮮度を偽装しているため。
3. **ループの信号品質** — 改善ループの配管は完成しているが流れているのは定型文。実際の改善は STATUS ledger の手動監査(これは健全)に依存しており、自動ループと接続されていない。

## 3. 目的

新規環境で `pnpm install → build → onboard → 組織・目標設定 → project → mission → schedule 稼働 → review` が、**ドキュメント以外の口伝知識ゼロで完走**し、完走後は**無人でスケジュール・通知・改善ループが回り続ける**状態にする。

### 完了時の利用者体験

- `pnpm onboard` が persona・identity・モデル選択・通知チャネルまで永続化して完了し、`dashboard:onboarding` が「Next: 組織を設定」へ進む。
- `pnpm organization purpose set` / `service add` / `objective add` で組織と目標を登録でき、`pnpm project create --organization-id` で最初のプロジェクトが組織に所属する。
- スケジューラは launchd 常駐で、死ねば 1 時間以内に baseline-check が `needs_attention` を返し通知が届く。
- ミッションの放置・ゴミは hygiene が定期的に検出し、改善バックログに自動起票される。

### 非目的

- onboarding wizard / mission controller / operating model の再設計はしない(接続と運転のみ)。
- 新しい万能ダッシュボードは作らない(既存 surfaces の起動と status 修復まで)。

## 4. 改善項目

### P0 — 運転の回復(止まっているものを動かし、止まったら見えるようにする)

- **LC-01 スケジューラ常駐化と死活監視**
  chronos-daemon を launchd(macOS)/ supervisor 管理下に置く生成セレモニーを追加。heartbeat が `tick 間隔 × 3` を超えて停止したら `sendOpsAlert`(critical)。baseline-check に「scheduler_alive」「schedules_firing(直近 24h に 1 件以上の lastRun 前進)」チェックを追加し、死んだまま `all_clear` を返さないようにする。failed のまま放置されたスケジュール(backup-daily 等 4 件)の再試行/エスカレーションポリシーを `checkScheduleHealth` に追加(現在はパイプラインが動いた時しか呼ばれない)。
  受け入れ基準: デーモン kill 後、次の baseline-check が `needs_attention` を返し、undelivered でない通知が 1 件記録される。
- **LC-02 通知チャネルの必須化と不達の棚卸し**
  `KYBERION_OPS_ALERT_WEBHOOK_URL`(または Slack bridge 等の配信先)未設定を onboarding services phase と baseline-check の warn 対象にする。`operator_notification_undelivered` 553 件を棚卸しし、チャネル設定後の再送 or 明示破棄コマンドを用意。
  受け入れ基準: mission-completed / deliverable-ready イベントが operator に push で届く。
- **LC-03 claude-cli シャドウイング解消**
  根本原因: `@anthropic-ai/claude-code` の postinstall 未実行 placeholder(`node_modules/.bin/claude`)が PATH 上で本物を隠す。対策: (a) `probeShellClaudeCliAvailability` で placeholder 検出時に `KYBERION_CLAUDE_CLI_BIN` へのフォールバック探索(`~/.local/bin/claude` 等)を追加、(b) `reasoning_setup.ts` のガイダンスに `pnpm approve-builds` / `KYBERION_CLAUDE_CLI_BIN` を明記、(c) INITIALIZATION.md に既知の落とし穴として追記。
  受け入れ基準: パイプライン起動時の `[shell-claude-cli] backend unavailable` 警告が消え、failover chain の primary が実際に claude になる。

### P1 — オンボーディングの完走性

- **LC-04 ドキュメント・カタログ整合**
  (a) `onboard:reset` を package.json に登録(スクリプトは実装済み・doc は既に案内済み)。(b) `phases/onboarding.md` Stage 2 の「onboard が dist を生成する」誤記を修正し、`customer/{slug}/` overlay の出力先を追記。(c) reasoning backend カタログを 4 ソース(INITIALIZATION.md / reasoning_setup ガイダンス / 対話メニュー / CLAUDE.md)で統一し、`probeReasoningBackend` に grok を追加、重複プローブ(codex/gemini/agy が同一関数内で 2 回)を除去。
- **LC-05 モデル選択の永続化**
  wizard の reasoning phase を「検出のみ」から「選択して `.env.local` に `KYBERION_REASONING_BACKEND` を書く」へ。既に何かの CLI が居ると選択プロンプトが一度も出ない `reasoning_setup.ts:103-123` の条件(`must > 0`)を「未永続化なら必ず確認」に変更。
  受け入れ基準: onboarding 完了後、auto-discovery ではなく記録された選択が使われる。
- **LC-06 外部サービス認証のガイド接続**
  wizard services phase のドラフト収集の次段として `setup_oauth.ts` / secret 設定への誘導を接続し、`services:setup` の「missing auth の next action が services:setup 自身」という循環を修正。blocked 4 接続(comfyui・whisper・voice・meeting)それぞれの必要変数は既に表示されているので、入力→検証→ready 化の一本道を作る。
  受け入れ基準: `dashboard:onboarding` の Connection Review で 4 接続のうち設定意思のあるものが blocked → ready に遷移できる。
- **LC-07 persona 登録の永続化**
  `KYBERION_PERSONA` は現在プロセス内でしか設定されず、後日の personal-tier 操作(Terminal HUD 等)が黙って権限不足になる。onboarding summary で選択 persona をプロファイル(`.env.local` または `my-identity.json` 連動の起動スクリプト)に永続化し、authority.ts の要求値と onboarding 出力を接続する。

### P1 — 組織・プロジェクト・目標の authoring

- **LC-08 `pnpm organization` に authoring サブコマンドを公開**
  core writer は実装済み(`saveOrganizationPurpose` / `saveOrganizationService` 等、現状テストのみが呼ぶ)。`purpose set` / `objective add` / `domain add` / `service add` / `operation add` / `project attach`(= `active_project_ids` 書き込み)を facade に追加する。これが無い限り「組織 state は facade 経由でのみ変更」という不変条件は**満たしようがない**(手編集が唯一の経路になっている)。tier guard の既定 persona 要件(`KYBERION_PERSONA=sovereign` が必要)も `--help` とエラーメッセージに明記。
  受け入れ基準: フィクスチャ以外の実組織を、JSON 手編集ゼロで purpose + objectives + service 1 件まで登録できる。
- **LC-09 project ↔ 組織 ↔ context chain の接続**
  `project create/bootstrap` に `--organization-id` / `--tenant-slug` を追加し、`pnpm work create-item` に `--context`(または `--mission-id --project-id --work-shape` 個別フラグ)を追加。mission dispatcher の metadata 経由持ち回り(`mission-ticket-dispatch.ts:337-356`)を typed context に置換、`importExternalWorkItem` 更新分岐の context 欠落も修正。ORGANIZATION_VIEW_SCOPE_ARCHITECTURE の pending step 2 の実装に相当。
  受け入れ基準: 新規 work item の `context` に organization_id〜work_shape が CLI から直接入り、metadata 持ち回り経路が deprecated warn を出す。
- **LC-10 facade 名の整理**
  `pnpm org`(実体は role/authority ツール)と `pnpm organization` の混同を解消(`org` → `role` へのリネーム or CLAUDE.md/GLOSSARY の記述修正)。`OPERATOR_UX_GUIDE.md` に `pnpm organization` の節を追加(現在ゼロ言及)。

### P2 — ミッション衛生と作業エルゴノミクス

- **LC-11 mission hygiene の対象拡大とゴミ掃除**
  hygiene の走査対象を `planned` だけでなく stale `active` / `distilling`(158 件)に拡大し、閾値超過を改善バックログ(learning enqueue)に自動起票。`--HELP` / `--ID` ゴミミッションと `MSN-*-TEST` 残骸の一括アーカイブ手順を整備し、CLI の位置引数誤パース再発を防ぐガード(mission ID バリデーション)を入れる。distilling 58 件は「distill が LLM backend を要するのに誰も駆動しない」ことが原因なので、スケジューラ復旧(LC-01)後に distill スイープをスケジュール登録する。
- **LC-12 reconcile-work / finish のエルゴノミクス**
  (a) `reconcile-work --generate` スキャフォールド(現況 git 状態から manifest 雛形とハッシュを自動生成)。(b) finish のゲート失敗時に exit code 非ゼロ + 機械可読な gate 結果出力(現在は log して return、exit 0 の経路がある)。(c) CLAUDE.md/AGENTS.md から reconcile-work ゲートへのリンクを 1 行追加(現在は finish が失敗して初めて学ぶ)。(d) `MISSION_ROLE=slack_bridge` 等の enqueue 役割要件を OPERATOR_UX_GUIDE に記載。
- **LC-13 CLI 起動税の削減**
  read-only サブコマンド(`--help` / `list` / `status`)でのプロバイダ探索・embedding bootstrap・kill-switch monitor 起動(約 1 秒 + ログ約 20 行)を遅延初期化にする。
- **LC-14 `surfaces:status` の修復とサーフェス起動の運転化**
  status が何も表示しない欠陥を修復し、enabled 宣言済みサーフェス(chronos-mirror-v2 / concierge / operator-surface)の常駐化を LC-01 と同じ supervisor 系に載せる。state.json(7/14 から未更新)の鮮度も status に表示。

### P2 — 改善ループの信号品質

- **LC-15 auto-learned hints の定型文抑制**
  「Step X produced a file artifact. Review trace …」型の hint を生成側で抑制(または confidence 0.1 以下に降格)し、信号のあるカテゴリ(adf-repair / human-rejection — 既に個別消費者がいる)に生成を寄せる。hint 品質の可視化(採用率)を feedback-loop に追加。
- **LC-16 自動ループと STATUS ledger の接続**
  failed schedule・hygiene 検出・undelivered 通知などの機械検出イベントを、手動監査で健全に回っている STATUS ledger / improvement-plans バックログへ自動起票する経路(`organization learning enqueue` の活用)を作る。「機械が見つけ、人（またはミッション）が裁く」形でループを閉じる。
- **LC-17 First-Win E2E チェックの拡張**
  既存の `check:first-win-smoke` を「onboard(非対話 `onboard:apply`)→ organization authoring → project attach → mission create→finish → schedule tick → hints 生成」の通し検証に拡張し、CI ではなく定期スケジュール(週次)で実環境相当に対して走らせる。**本計画全体の受け入れ基準を兼ねる。**

## 5. 実装順序

| フェーズ            | 項目                       | 理由                                                              |
| ------------------- | -------------------------- | ----------------------------------------------------------------- |
| Phase 1(即時・独立) | LC-01, LC-02, LC-03, LC-04 | 停止中の運転の回復と既知の罠の除去。相互依存なし、いずれも小規模  |
| Phase 2             | LC-05, LC-06, LC-07, LC-08 | オンボーディング完走性と組織 authoring。LC-08 は LC-17 の前提     |
| Phase 3             | LC-09, LC-10, LC-11, LC-12 | 接続(context chain)と衛生。LC-11 の distill スイープは LC-01 依存 |
| Phase 4             | LC-13〜LC-17               | エルゴノミクス・信号品質・通し検証。LC-17 が全体の完了判定        |

## 6. リスク・注意

- LC-01 の launchd 常駐化は sandbox/権限承認が必要(approval-first 原則)。生成セレモニー(provider state と同様の再生成可能な形)で管理する。
- LC-08 の authoring は tier guard・audit との整合が必須(deny-unless-brokered を緩めない)。writer は既存実装を使い、facade 層で authority 検査を通す。
- LC-11 の一括アーカイブは破壊的操作なので、dry-run 既定 + レシート必須で実装する。
- 本計画の検証はすべて read-only で実施済み。数値(158 件放置、553 件不達等)は 2026-08-08 時点のスナップショット。

## 7. 実装状況

- 2026-08-08: 計画起草。検証エビデンスは §2 に記載。
- 2026-08-08: **Phase 1 + LC-05 + LC-08 実装完了**(同日)。
  - **LC-01 完了**: baseline-check に L10 レイヤ(`scheduler_alive` / `schedules_firing` / failed-schedule sweep)追加(`scripts/run_baseline_check.ts`)。stale heartbeat で critical ops-alert(日次デデュープ)。`pnpm chronos:install` / `chronos:uninstall`(launchd 生成セレモニー、既定 dry-run)。実機で LaunchAgent 導入済み(`com.kyberion.chronos`)。
  - **LC-02 完了**: `pnpm ops:alerts`(サマリ / `--redeliver` / `--ack`、履歴は append-only)。baseline-check と `services:setup` に通知チャネル未設定警告。`services:setup` の customer overlay 読み取りは LC-06 で sensitive-path mediation に接続。
  - **LC-03 完了**: `shell-claude-cli-backend.ts` に placeholder 署名検出+周知ディレクトリへのフォールバック解決(実機で `~/.local/bin/claude` を自動選択、警告消滅、failover chain に claude-cli 復帰)。`KYBERION_CLAUDE_CLI_BIN` / `pnpm approve-builds` の修復ガイダンスを reasoning:setup / INITIALIZATION.md に追記。
  - **LC-04 完了**: `onboard:reset` 登録、phases/onboarding.md Stage 2 修正+customer overlay 出力先追記、backend カタログを `loadReasoningBackendPolicy().allowed_modes` を単一情報源として 4 ソース統一、`probeReasoningBackend` に grok 追加+重複プローブ除去+明示バックエンドの個別プローブ(`probeExplicitReasoningBackend`)。
  - **LC-05 完了**: wizard reasoning phase で選択→ `.env.local` に `KYBERION_REASONING_BACKEND` 永続化(上書きは確認制)。`onboard:apply` に `reasoning_backend` フィールド。identity→services スキップバグ修正。
  - **LC-08 完了**: `pnpm organization` に authoring サブコマンド公開(`init` / `purpose set` / `objective add` / `domain add` / `service add`(親 domain `service_ids` 同期)/ `operation add` / `project attach|detach`(プロジェクトレジストリ実在検証))。core builder 関数群+テスト追加。OPERATOR_UX_GUIDE に組織登録節(LC-10 の doc 部分を前倒し)。
  - **LC-06 完了**: `services:setup` の self-referential next action を廃止し、OAuth 対応 preset は `setup_oauth.ts`、secret-backed preset は Secret Guard の入力指示へ分岐。`pnpm onboard -- --services-only --service <id>` を追加し、ComfyUI / Whisper / Voice / Meeting の入力を readiness 必須キーへ変換して connection document を `ready` / `blocked` として保存。customer overlay の読み取りも mediation 下で実行。
  - **LC-07 完了**: wizard / `onboard:apply` が選択 persona を `.env.local`、`my-identity.json`、`agent-identity.json`、onboarding summary/state に記録。`authority.resolveIdentityContext` は明示 env、mission state に続く profile persona fallback を持ち、後続プロセスでも権限不足へ黙って落ちない。
  - **LC-06/07 検証**: typecheck / build:packages / build:repo、対象 6 テストファイル 38 件、contract-schemas / script-integrity / process-registry / env-registry / esm / golden を通過。サービス setup の live probe は既存の外部 CLI probe が長時間化するため実機コマンド全体は中断し、next-action の純粋ロジックをテストで検証。
  - 検証: `pnpm typecheck` / `build:packages` / `build:repo` / `build:actuators` クリーン、対象 10 テストファイル 124 件全通過、check:script-integrity / process-registry / env-registry / governance-rules / esm / golden 通過。baseline-check 実機で `needs_attention`(L10、heartbeat 停止 5.8 日)を正しく検出。
  - 副次修正: `procedure-registry.test.ts` のキャッシュテストを密閉化(personal カタログ存在マシンで恒常失敗していた)。
  - 既知の注意: `mission-work-reconciliation.test.ts` の 4 件は package.json が未コミットの間は設計どおり失敗する(commit-bound 検証。コミット後に回復)。`mission-workitem-dispatch.test.ts` の linked-project テストはマシン状態(ヒント肥大によるプロンプト予算超過)で失敗 — LC-15 の実害エビデンス。
- 2026-08-08(続報): **スケジューラ実機復旧の知見**。
  - launchd LaunchAgent は `StandardOutPath` / `StandardErrorPath` が外部ボリューム(`/Volumes/data/...`)上にあると **EX_CONFIG (78) で spawn 失敗**する(21 回 spawn loop を実測)。ログは `~/Library/Logs/kyberion-chronos.log` に置く(browser-bridge と同じ前例)。セレモニーの plist 生成を修正済み。
  - launchd の既定 PATH は `/usr/bin:/bin:/usr/sbin:/sbin` で `node`/`pnpm` が無く、`system:exec` 系パイプラインが即死する。plist に `EnvironmentVariables.PATH`(node bin dir + `/opt/homebrew/bin` 等)を注入するよう修正済み。
  - PfcController の回路遮断は一度開くと再評価されない永久ラッチだった(手編集以外の解除経路なし)。回路オープン時も 1 回/ランのプローブを実行し、成功で自動クローズするよう修正(`libs/core/src/pfc/PfcController.ts`、テスト追加)。復旧後の baseline-check は実機で `all_clear` を確認。
  - `bootout` 直後の `bootstrap` は error 5 になることがある(数秒待って再試行で解決)。
  - 残存する failed schedules は**アプリレベルの既存問題**(例: mesh-delivery は `KYBERION_MESH_PEER_ID` 未設定 — オンボーディング未完の一部、LC-06/07 域)。8/2 の端末デーモン時代から失敗しており launchd 化の退行ではない。
- 残: LC-09〜LC-17(Phase 3〜Phase 4)。
- 2026-08-08(Phase 3着手): **LC-09〜LC-12の実装を開始**。project create/bootstrapの組織・tenant入力、work create-itemのtyped context、mission ticket dispatchのtyped context、外部work item更新時のcontext保持、hygieneのactive/distilling検出と組織 learning enqueue、reconcile-work scaffold生成、finish gate失敗の非0終了、AGENTS/Operator guideの導線を追加。reconcile既存テストのcommit-bound 4件は、未コミット作業ツリーでは既知条件により失敗するため、コミット後に再検証する。
- 2026-08-08(Phase 4着手): **LC-13/LC-15を実装**。CLIのhelp/list/info等のread-onlyコマンドではreasoning・embedding・voiceのruntime bootstrapを遅延し、`list --check`と実行系だけが起動するようにした。feedback-loopは成功artifactの存在だけから定型hintを生成せず、低信号なauto-learned hintの蓄積を抑制する。
- 2026-08-08(Phase 4続行): **LC-14/LC-16を実装**。`run_with_env` が子プロセスstdoutを転送するよう修正し、`pnpm surfaces:status` がJSONのhealth・stale state・next actionを表示するようにした。scheduler失敗と未達ops-alertを決定論的なorganization learning候補へ接続し、候補は提案状態のまま人またはミッションが裁く。残りはLC-17のFirst-Win通し検証拡張。
- 2026-08-08(Phase 4 LC-17): **First-Win lifecycle dry-runを実装**。`onboard:apply --dry-run` → `organization init --dry-run` → `project create --dry-run` → `mission create --dry-run` → weekly schedule tick → meaningful hint生成を1コマンドで検証する`check:first-win-lifecycle`と、月曜週次の`first-win-lifecycle-weekly` pipelineを追加。project facadeにもcreate dry-runと純粋なrecord builderを追加した。外部認証・実機schedule発火を伴うapply/live受入は次の実環境証跡に残す。
