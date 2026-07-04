# AO-01: 自律保守ループと定期メンテナンスの実配線

> 優先度: P1 / 規模: M / 依存: KM-01(GC 配線)、OP-04(健全性)、AO-03(エスカレーション) / 関連: [AUTONOMOUS_MAINTENANCE_JUDGMENT](../AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md) §4 のループ・§1-2 の判断
>
> **なぜ重要か**: 判断基準文書 §4 の「観測→診断→判断→実行→検証→記録」ループを実際に回す機構。スケジューラは存在するが**実ジョブがゼロ**で、保守が無人で走らない。

## 背景と課題

- **スケジューラにジョブがゼロ**: `chronos_daemon.ts`(60秒 tick、`:22,:138`)は `pipelines/**.json` の `schedule.cron` を拾うが、**どのパイプラインも cron を宣言していない**(`grep '"cron"'` ゼロ)。スケジューラは空回り。
- **missed-run/overlap 安全機構が弱い**: ダウン中に過ぎた cron 分は silent skip(backfill なし、`pipeline-scheduler.ts:115-134`)。overlap は(2026-07-03 レビュー訂正)**`chronos_daemon.ts:~95-100` が実行前に `lastRun` を楽観スタンプする best-effort ガードが既にある**が、真の run-lock(実行中フラグで再入を確実に防ぐ)ではないため、失敗/長時間実行時の二重起動を確実には防げない。本計画は best-effort を確実な per-pipeline run-lock に格上げする。
- **janitor が実運用で走らない**: `storage-janitor` の `runJanitor` は demo(`scenario_storage_governance.ts:187`)が `dryRun:true` で呼ぶだけ。30日でログ/tmp/runtime が無制限に肥大。(**単一オーナー 2026-07-03**: janitor/GC の cron 配線は **KM-01 が所有**。本計画は健全性/tenant-drift/依存スキャン/auto-checkpoint の配線と、判断駆動の自動/承認振り分けに集中し、janitor cron 自体は KM-01 に委ねて重複を作らない。`detectRegressions()` の劣化検知は OP-04 所有。)
- **auto-checkpoint 未実装**: 長時間ミッションの自動チェックポイントが未整備(`MISSION_LIFECYCLE_AUDIT.md:124` F4 未了)。
- **判断基準に沿った自動/承認の振り分けが無い**: 何を無人で行い何を人間に回すかのポリシーが未実装(判断基準 §1-2 が未実装)。

## ゴール(受入条件)

1. 実際の定期メンテパイプライン(janitor 実行・健全性スキャン・tenant-drift・依存/脆弱性スキャン AO-02・auto-checkpoint)が `schedule.cron` で登録され、chronos で無人実行される。
2. スケジューラに **missed-run catch-up**(ダウン復帰後に取りこぼした定期ジョブを 1 回補填)と **per-pipeline run-lock**(重複実行防止)が入る。
3. 各保守アクションが判断基準文書 §1-2 の 4 軸で自動/事後通知/承認必須に振り分けられ(`autonomous-ops-policy.json`)、承認分は AO-03 のエスカレーションへ。
4. 長時間ミッションの auto-checkpoint が定期発火する。

## 実装タスク

### Task 1: スケジューラの堅牢化 — `claude-sonnet-4`

1. `pipeline-scheduler.ts` に missed-run catch-up(前回 tick からの経過で取りこぼした cron を検出し 1 回補填、多重補填はしない)と、実行中フラグによる per-pipeline run-lock を追加(`chronos_daemon.ts:138-145` の tick が前回完了を尊重)。
2. 長時間ジョブが次 tick を跨いでも二重起動しないこと、ダウン→復帰で 1 回だけ補填されることをテスト。

### Task 2: 保守ポリシーと振り分けエンジン — `claude-sonnet-4`

1. `knowledge/product/governance/autonomous-ops-policy.json` を新設(判断基準文書 §2 の表を機械可読化: アクション → 4 軸 → 既定 auto/notify/approve)。テナント override 可。
2. `libs/core/autonomous-ops-gate.ts`: 保守アクションを受け、ポリシーで自動/通知/承認を判定して返す(SA-05 の承認ゲート・OP-01 の予算・判断基準 §1 を統合)。fail-closed(判定不能は承認へ)。
3. unit test: 各アクションの振り分け、fail-closed。

### Task 3: 定期メンテパイプラインの配線 — `claude-sonnet-4`

1. 以下に `schedule.cron` を付ける(KM-01 と協調、重複させない): `storage-janitor`(日次、`runJanitor({dryRun:false})` — 初回は dry-run 観測後に有効化)、`baseline/health スキャン`(OP-04、時間毎)、`tenant-drift`(既存 `watch_tenant_drift`、日次)、`dependency-vuln スキャン`(AO-02、日次)、`auto-checkpoint`(実行中ミッションの定期チェックポイント)。
2. 各パイプラインの結果は Task 2 のゲートを通し、自動分は実行・記録、要承認分は AO-03 へ。
3. `pnpm pipeline --input pipelines/baseline-check.json` と各メンテパイプラインの手動実行で確認。

### Task 4: 自律保守ループの統合 — `claude-sonnet-4`

1. 判断基準 §4 のループ(観測→診断→判断→実行→検証→記録)を、上記を束ねる 1 つの定期パイプライン(または chronos の統合ジョブ)として実装。診断は決定論閾値を第一段、曖昧分類のみモデル(HN-01 の tier: haiku で採点、sonnet で診断)。
2. 実行結果を監査(SA-01)+ 学習(KM-03、有効だった対処の昇格)。
3. E2E: 問題注入(disk 逼迫・stale リース)→ 自動対処 → 検証 → 記録。

## リスクと注意

- janitor の初回実運用は削除操作。**必ず dry-run で対象一覧を確認してから** `dryRun:false` に切り替え(KM-01 の注意と同じ)。
- 自律保守の暴走(誤診断での過剰対処)を防ぐため、Task 2 のゲートは fail-closed、判断基準 §6 の不変条件(不可逆×広域は人間)を厳守。
- missed-run catch-up が「大量の取りこぼし一括実行」で負荷を出さないよう、補填は最新 1 回のみ(履歴全消化しない)。
