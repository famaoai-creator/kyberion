# KM-01: 揮発メモリ層の起動 — 実装済みライフサイクルを実際に回す

> 優先度: **P0** / 規模: S / 依存: なし / 関連: [VOLATILE_KNOWLEDGE_PLAN](../../VOLATILE_KNOWLEDGE_PLAN.ja.md)(本 IP は同計画の**起動・配線**であり再設計ではない)

## 背景と課題

VOLATILE_KNOWLEDGE_PLAN の Phase 1〜5 は**コードとしてはほぼ完成している**のに、動かす仕掛けが無く休眠している。

- working-memory-actuator は 14 op 全部が実装・dispatch 済み(`libs/actuators/working-memory-actuator/src/index.ts:573-586`。※以前の調査メモにあった「TODO 7件」は誤りで、grep ヒットは TODO.md ジャーナリング**機能**の文字列)。スキーマ(`schemas/volatile-knowledge.schema.json`)、`pathResolver.volatile()`(`libs/core/path-resolver.ts:67`)、パイプライン 4 本(`pipelines/{volatile-gc,daily-routine,weekly-review,volatile-index}.json`)も存在する。
- しかし **どのパイプラインにも `schedule.cron` が無い**。`scripts/chronos_daemon.ts:52` は `adf.schedule?.cron` を持つパイプラインだけを登録するため、4 本は**永遠に自動実行されない**。
- **storage-janitor の `runJanitor()` はデモスクリプト(`scripts/scenario_storage_governance.ts:10`)からしか呼ばれず**、TTL GC(tmp 24h / logs 30d / data-vault / receipts 90d)は本番で一度も走らない。
- 使われていない証拠: `active/personal/` が存在せず、揮発サイドカーはリポジトリ全体で 2 ファイルのみ(`active/archive/missions/SBIJSM-DESIGN-IMPORT/`)。

これは今回の全調査の中で**最も費用対効果が高い修正**(小さな配線で、設計済みの学習・衛生ループ全体が動き出す)。

## ゴール(受入条件)

1. `volatile-gc`(日次)/ `daily-routine`(日次)/ `weekly-review`(週次)/ `volatile-index`(日次 or 週次)が chronos daemon 経由で自動実行される。
2. storage-janitor の TTL GC が定期実行され、`active/shared/tmp/` の 24h 超ファイルが実際に回収される。
3. セッション lifecycle(review フェーズ / mission finish)から working-memory の `nominate-promotion` と GC が呼ばれる導線が入る。
4. 1 週間の試行後、`active/` 配下に日次/週次ファイルが実際に生成・ローテートされていることを確認できる。

## 実装タスク

### Task 1: cron 配線 — `claude-sonnet-4`

1. `chronos_daemon.ts` のスケジュール仕様(`adf.schedule?.cron` の期待形式)を読み、4 パイプラインに `schedule` ブロックを追加する: volatile-gc 04:00 日次 / daily-routine 06:00 日次 / weekly-review 月曜 07:00 / volatile-index 05:00 日次(時刻は既存のスケジュール例があればそれに合わせる)。
2. storage-janitor 用に `pipelines/storage-janitor.json`(`runJanitor` を呼ぶ 1 ステップ + 日次 cron)を新設する。`scenario_storage_governance.ts` 内の擬似レイテンシ sleep(`:96,156`)は本番パイプラインに持ち込まない(janitor 本体 `libs/core/storage-janitor.ts` を直接呼ぶ)。
3. パイプラインスキーマ(`pipeline-adf.schema.json`)が `schedule` を許容するか確認し、必要ならスキーマ更新。`check:pipeline-shell-independence` / `pnpm validate` を通す。
4. chronos daemon をローカルで起動し、登録ログに 5 本が載ることを確認する。

### Task 2: セッション lifecycle への接続 — `claude-sonnet-4`

1. review フェーズの runbook(`knowledge/product/governance/phases/review.md`)と mission finish(`scripts/mission_controller.ts` の finish 経路)を確認し、(a) mission finish 時に `working-memory: nominate-promotion`(該当ミッションの MEMORY サイドカーから昇格候補を積む)、(b) 週次 `run-gc` の 2 点を呼ぶ導線を追加する。
2. finish 時の呼び出しは失敗してもミッション完了自体を妨げない(warn + trace 記録)。
3. テスト: fixture ミッションで finish → promotion queue に候補が積まれることを確認。

### Task 3: 稼働の観測 — `claude-haiku`

1. chronos daemon の実行結果(最終実行時刻・成否)を `pnpm dashboard`(または doctor)の 1 セクションとして表示する(既存の daemon 状態表示があれば拡張)。
2. `docs/OPERATOR_UX_GUIDE.md` に「日次/週次で何が自動実行されるか」の表を追記する。

### Task 4: 1 週間試行の評価 — `claude-sonnet-4`(実装後 1 週間経過時に実施)

- `active/` 配下の生成物(daily/weekly/GC ログ)を確認し、VOLATILE_KNOWLEDGE_PLAN §7 の受入条件との突合結果を同計画の文書にステータス追記する。動いていないパイプラインがあれば原因を調査して修正する。

## リスクと注意

- chronos daemon が常駐していない運用形態(手動セッションのみ)では cron が発火しない。**フォールバックとして baseline-check(セッション開始)に「前回 GC から 24h 超なら janitor を非同期起動」する軽量フックを追加**する(IP-12 の baseline 高速化と干渉しないよう非同期・失敗許容で)。
- GC は削除操作。初回稼働時は dry-run モード(janitor に既存の dry-run があれば利用、無ければ追加)で 1 回回し、削除対象一覧を確認してから有効化する。

## 実装メモ

### Task 1 shelf result — 2026-07-03

- `pipelines/volatile-gc.json` / `daily-routine.json` / `weekly-review.json` / `volatile-index.json` に `schedule.cron` を追加した。
- `pipelines/storage-janitor.json` を追加し、`libs/core/storage-janitor.ts` の `runJanitor()` を `core:run_janitor` 経由で直接呼ぶようにした。手動検証は `--context '{"dry_run":true}'` で削除なしに実行できる。
- `package.json` に `storage:janitor` を追加した。
- 検証:
  - `pnpm exec vitest run scripts/run_pipeline.test.ts libs/core/storage-janitor.test.ts`
  - `pnpm run typecheck`
  - `pnpm run check:script-integrity`
  - `pnpm run check:pipeline-shell-independence`
  - `pnpm run build:repo`
  - `pnpm pipeline --input pipelines/storage-janitor.json --context '{"dry_run":true}'`
  - `node dist/scripts/chronos_daemon.js` 起動確認で 5 schedule (`daily-routine`, `storage-janitor-daily`, `volatile-gc-daily`, `volatile-index-daily`, `weekly-review`) が登録された。

### Task 2 shelf result — 2026-07-03

- `scripts/refactor/mission-lifecycle.ts` の finish 経路に、mission `MEMORY.md` の `## Decisions` / `## Lessons Learned` から promotion summary を抽出して `memory-promotion-queue` に evidence 付きで積む導線を追加した。
- promotion 候補が queue された場合、対応する `MEMORY.volatile.json` の `status` と `promotion_candidate_id` を更新する。
- finish 時に `pipelines/volatile-gc.json` を失敗許容で起動する。runner が未 build の場合は mission 完了を妨げず warn + trace event に留める。
- `knowledge/product/governance/phases/review.md` を、finish hook が Volatile Distillation Lane を自動実行する前提へ更新した。
- 検証:
  - `pnpm run typecheck`
  - `pnpm exec vitest run scripts/run_pipeline.test.ts libs/core/storage-janitor.test.ts`
  - `pnpm run build:repo`

### Task 3 shelf result — 2026-07-03

- `scripts/run_doctor.ts` に pipeline schedule registry の表示を追加した。`pnpm run doctor` で schedule id / enabled / cron / lastRun / lastStatus を確認できる。
- `docs/OPERATOR_UX_GUIDE.md` に volatile memory layer の日次/週次自動実行表を追加した。
- 検証:
  - `pnpm exec vitest run scripts/run_doctor.test.ts`
  - `pnpm run typecheck`
  - `pnpm build`
  - `pnpm run doctor` で 5 schedule が表示され、required capabilities は satisfied。
