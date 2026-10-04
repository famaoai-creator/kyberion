---
title: 'Resident dot 自律組織ループ計画 (DL-01〜11)'
tags: [dots, autonomy, organization, plan]
last_updated: 2026-10-04
---

# Resident dot 自律組織ループ計画 (DL-01〜11)

- Mission: `MSN-DOT-ORG-LOOP-20261004`
- Branch / worktree: `feat/dot-org-loop-20261004` / `kyberion-dot-loop`
- 前提: PR #907 (resident dots), PR #908 (decision expiry)
- 背景: OpenAI Dots 相当の「常駐・自律・目標駆動」ループを Kyberion の resident dot で閉じる。
  現状は wake → propose → WorkItem 作成で止まっており、実行・成果評価・学習が無い。

## 0. 現状の根本原因 (DL-02)

| 症状                                    | 原因                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 435 件 `charter status is unreadable`   | `runDotWake` が `listDotCharters(rootDir)` を `errors` 無しで再読込 → 兄弟 charter の 1 件の失敗で throw → bare `catch {}` で握り潰し。長寿命 daemon (stale dist / validator キャッシュ) 上で org-operations の読込が失敗していた。回転する watch key のため skip が無限に増える |
| 25 件 `backend lacks generateWithTools` | supervisor daemon が `installReasoningBackends()` を呼ばず stub backend のまま。現行コードでは stub の `delegateTask` で `[STUB]` を delivered 扱いする偽成功になっている                                                                                                        |
| `failed across 0 candidate(s)`          | Failover backend が構築時に tools 対応を宣言するが、呼出時に demoted provider を除外し候補 0                                                                                                                                                                                     |
| WorkItem が閉じない                     | 実行者不在のため `max_concurrent_delegations` を永久に占有                                                                                                                                                                                                                       |
| tenant charter 未読込                   | `listDotCharterPaths` が repo `dots/` のみ走査                                                                                                                                                                                                                                   |

## 1. 共通規約

- 状態ドメイン `active/shared/runtime/dot/`。配置は `dotStatePath(charter, ...parts)` に一本化。
  tenant dot は `physicalScopedPath('active/shared/runtime/dot', {tenant_slug, organization_id}, ...)`。
  tenant の文章 (memory / 理由 / event 本文 / 結果) は system floor に置かない。
- JSON I/O は foundation の `readJsonIfPresent` / `writeJson` / `appendJsonLine` / `readJsonLines`、secure-io のみ。
- ログは `createLogger('dot-…')`、warn/error は `what — why | next | evidence`。
- 拡張シーム: `libs/core/dot/dot-extensions.ts` (interface) + `dot-extension-registry.ts` (順序付き配列)。
  `DotPromptSection` / `DotFloorContributor` / `DotPreGateCheck` / `DotDecisionRelaxer` / `DotWakeTool` /
  `DotStatusSection` / `DotDigestSection`。daemon 側は `scripts/dot_supervisor_extensions.ts` の
  `DOT_SUPERVISOR_STEPS`（各 step は try/catch で隔離）。後続タスクは registry に 1 行追記するだけ。
- 新規 `libs/core/dot/*.ts` は `libs/core/index-part-11.ts` に `export *` を追記（名前は `dot` 接頭辞で一意）。
- 各タスクは `changelog.d/dot-<slug>.md` を追加。

## 2. 項目別設計

### DL-02 ランタイム信頼性

- `runDotWake` は自分の charter ファイルだけを `loadDotCharter(path)` で再読込。失敗は **failed** + 実エラー + `next: pnpm kyberion dot validate`。
- `buildDotDueChecker` を export し、キー単位の指数バックオフ `min(5min*2^(n-1), 6h)`。
- dot 単位 circuit: 直近 5 wake が同一正規化理由で failed → `lastFailedAt + backoff` まで抑止、ops alert 1 回。
- `DueDotTrigger.trigger` に `{kind:'followup'}`、ledger kind に `followup`、row に `circuit?`。
- executor からの self-inbox (`payload.report_from === 'dot-executor'`) で wake。
- `dot-wake-backend.ts`: `resolveDotWakeBackend` → `tool | fence | unavailable`。stub は unavailable（テスト/明示 stub 除く）。
  `backendHasLiveToolCandidate` (reasoning-backend.ts に `liveCapabilities()` 追加、demoted 除外)。
- tool loop が 0 turn で tools 不在エラー → 同一 wake 内で fence 経路へ劣化。
- charter validator は schema mtime 変化で再コンパイル。
- daemon: `installReasoningBackends()`、30 分毎 `reselectReasoningBackends()`、charter エラーを heartbeat `details.charter_errors`、code stamp drift で `stale_code: true` 警告（自動再起動しない）、`runDotSupervisorExtensions` 呼出、`runDotSweepOnce` に deps seam。
- dispatch のフック: floor contributors を strictest に合成 → relaxers（`gate.decision` と `charter.decisions.default_decision` 未満にはしない）、pre-gate checks（escalate は approve 強制 + card_context）、digest sections。
- tenant charter: `knowledge/confidential/<slug>/dots/*.json`（登録済み tenant、symlink 不可）。

### DL-01 dot WorkItem 実行器

- `libs/core/dot/dot-executor.ts`（ports 注入: `runGoalTurn` / `delegateText` / `runPipeline`）。
- 1 dot / sweep 最大 1 件: lease 付き `claimWorkItem`（actor `dot:<id>`、idempotencyKey = action_ref）→ 事前に KR snapshot。
- ルーティング: `pipeline` は `charter.authority.allowed_pipelines` 内の `pipeline_ref` のみ / `task_session`・`direct_reply` は charter role の bounded goal turn（tool backend 不在なら delegateText で read-only 結果）/ `mission` は実行せず blocked（mission_controller 経由のみ）。
- `releaseWorkItem(done|blocked)`、`work-results.jsonl`、audit chain、dot inbox に report-back → dot wake。
- 全体を `withExecutionContextAsync(charter role, tenant)` 内で。daemon 側配線は `scripts/dot_executor_step.ts`。
- dispatch の WorkItem metadata に `pipeline_ref` / `expected_effect` / `target` / `intent`。

### DL-03 KPI ゴール

- `libs/core/key-result-spec.ts`: `KeyResultSpec {kr_id,title,metric,target,direction,baseline?,unit?,weight?,every_s?,settle_minutes?}`、metric は `probe | file | signal_ratio | org_metric`。`keyResultProgress()`。
- charter: `goal.key_results` (≤10)、`team.goal_ref` は `string | {organization_id?, objective_id}`、`dotGoalRefLabel()`。
- org: `OrganizationPurposeObjective.key_results`、`pnpm organization objective kr add|list|remove`。
- `dot-key-results.ts`: 計測 → `kr-ledger.jsonl`（org は scoped `org-kr-ledger.jsonl`）、`dotGoalGapLines()` を wake prompt へ（`weight*(1-progress)` 順 + 24h trend）。
- `organization-objective-progress.ts`: objective の重み付き roll-up。

### DL-04 成果評価

- `dot-outcomes.ts`: done 結果ごとに `settle`（KR settle_minutes → charter `goal.outcome_settle_minutes` → 60 分）後に再計測、`improved|no_change|regressed|unmeasurable`。
- `outcomes.jsonl`、prompt / digest、regressed は `recordExecutionFeedback`。learned floor (dot-feedback) は動かさず autonomy が消費。

### DL-05 dot ワーキングメモリ

- `dot-memory.ts`: `memory/<dot>.json` に notes / open_items / hypotheses（各 20、400 文字、8KB 上限、決定的 eviction）。
- wake tool `dot_update_memory` / fence ` ```dot-memory `（1 wake 10 op まで）、prompt section、週次 distill → execution feedback candidate。

### DL-06 組織ケイデンス定期実行

- tick コアを `libs/core/organization/organization-operation-tick.ts` に抽出（CLI facade は薄いラッパ）。
- `organization-standup.ts` / `organization-retro.ts` → `writeScopedArtifact` + operator notification。
- ops `core:organization_operation_tick|standup|retro`、pipelines `organization-operation-tick.json` (*/15)、`organization-standup.json` (平日 8:45 JST)、`organization-retro.json` (金 17:00)。

### DL-07 組織予算ガバナー

- `libs/core/governance/org-budget-governor.ts`: dots / missions / generation の日次使用量を tenant/org 単位で集計、`normal|soft|hard`。
- 既定: `daily_token_cap` 3,000,000 / tenant、`soft_ratio` 0.8（propose-only = floor approve）、`hard_ratio` 1.0（wake・executor 停止、housekeeping 継続）、cost cap は `spend-policy.daily_cap_usd` 継承。policy は `spend-policy.json` の `org_budget`。

### DL-08 インバウンドイベント

- charter trigger `{kind:'event', sources, types?, match?}`。
- `dot-event-intake.ts`: HMAC-SHA256 検証（secret は secretGuard）、正規化、delivery_id 重複排除、tenant は policy からのみ。
- `event-intake-policy.json`（全 source 既定無効）、`scripts/event_intake_surface.ts`（127.0.0.1、`POST /events/<source>`、viewer を持たない machine principal なので Chronos には載せない）。
- env `KYBERION_EVENT_INTAKE_PORT` / `KYBERION_EVENT_INTAKE_HOST`。

### DL-09 自己スケジュール + cron catch-up

- `dot-followups.ts`: wake tool `dot_schedule_followup` / fence ` ```dot-followup `、5 分〜7 日、pending 3 件、1 wake 2 件。
- cron catch-up: `runtime.cron_catch_up_hours`（既定 6、最大 24）内の取りこぼしを 1 件に合体して発火（二重発火なし）。

### DL-10 段階的自律 L0〜L4

- L0 shadow / L1 approve-all / **L2 supervised（既定 = 現状）** / L3 trusted（1 承認で learned floor 解除、7 日で減衰）/ L4 autonomous（policy 指定の可逆 action のみ notify→auto、outcome 成功率 ≥0.8）。charter floor と gate approve は決して緩めない。
- 昇格: 20 決定、一致率 ≥90%、成果成功率 ≥80%、30 日 incident 0 → decision card、人間承認でのみ適用。降格は自動。既定 max_level L3。

### DL-11 dot 間調停

- proposal に `target`（正規化リソースキー）と `intent`、charter `team.owns` / `team.priority`。
- `dot-arbitration.ts`（pre-gate check）: 6h 以内の他 dot の parked/dispatched action と同一 target・対立 intent → owner 優先 → priority 差 ≥10 → それ以外は 1 枚の decision card に統合（supersedes リンク）。`arbitration.jsonl`、承認時に旧 action を `superseded` で decline（learned floor は上げない）。

## 3. Wave 計画（ファイル所有は排他）

| Wave             | タスク                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 基盤          | T1.2 契約 (charter 型/schema 全追加、proposals、key-result-spec、dot-state-paths) → T1.1 信頼性 + シーム (dot-runtime / wake-orchestration / wake-backend / extensions / dispatch フック / reasoning-backend / daemon)、T1.3 予算ガバナー、T1.4 org KR モデル |
| W2 ループ中核    | T2.1 executor + 予算配線、T2.2 memory + followups + catch-up、T2.3 KR エンジン、T2.4 event intake                                                                                                                                                             |
| W3 評価・統治    | T3.1 outcomes、T3.2 ケイデンス、T3.3 autonomy、T3.4 arbitration                                                                                                                                                                                               |
| W4 面・文書・E2E | CLI/status、docs、`dot-loop.integration.test.ts`、live rollout（運用者承認後）                                                                                                                                                                                |

## 4. 状況

| ID        | 状態   |
| --------- | ------ |
| DL-01〜11 | 実装中 |
