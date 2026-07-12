# IP-03: CI テスト実行範囲の拡大と品質ゲート強化

> 優先度: **P0** / 規模: M / 依存: なし / 関連: IP-07(テスト追加)、IP-11(ラチェット)

## 背景と課題

リポジトリには 589 の `*.test.ts` があるが、CI で実行されるのはごく一部で、品質ゲートの多くが「定義されているのに実行されない」状態にある。

- `.github/workflows/ci.yml:101-142` のテストマトリクス:
  - `smoke` → `vitest run tests/smoke.test.ts`(1ファイル)
  - `unit` → `test:core` = `vitest run libs/core/`
  - `integration` → **smoke と同じ 1 ファイル**(`test:integration` の定義が `tests/smoke.test.ts`)
- その結果、**`libs/actuators/` の 43 テスト・`scripts/` の 47 テスト・`tests/` の契約/統合テスト約130ファイルは、どのワークフロー(`ci.yml`, `pr-validation.yml:53`, `cross-os.yml:53`, `release.yml:36`)でも実行されない**。ガバナンス境界テスト(`tests/foundation-io-boundary.test.ts` ほか3本)も未実行。
- `vitest.config.mts:30-62` のカバレッジ閾値 60% は、`test:coverage` がどのワークフローからも呼ばれないため**飾り**。
- `format:check` はどのワークフローにも無い。pre-commit(`.husky/pre-commit` → lint-staged)は `knowledge/**/*.md` に対する echo だけで、**コードには何も走らない**。
- 実 sleep・ポーリング・60秒タイムアウトを持つテストが複数あり(下記 Task 5)、実行範囲を広げた際の flake 源になる。

## ゴール(受入条件)

1. PR 時に actuators / scripts / tests(契約・境界)の全テストが実行される(シャーディング可)。
2. `integration` シャードが smoke の重複ではなく `tests/` ディレクトリを実行する。
3. カバレッジ閾値が CI で強制される(初期値は現状実測値ベースに調整可。閾値を下げる場合は理由を PR に明記)。
4. `format:check` が CI に入り、pre-commit で lint-staged が staged ファイルへ eslint + prettier を実行する。
5. 上記を通すために既存テストの失敗が見つかった場合、**黙って除外せず**、修正 or 明示的 skip(理由コメント + 課題化)で処理し一覧を報告する。

## 実装状況 (2026-07-04)

- **完了(Task 2)**: `ci.yml` の test マトリクスは `smoke / core / actuators / scripts / integration` の5シャード。`test:integration` は `vitest run tests/` を実行。`pr-validation.yml` は `test:core` + `test:actuators` + 境界テスト4本 + `format:check:ci` を必須実行。`release.yml` は `validate` 後に `test:all` + `check:golden` を実行。
- **完了(Task 2 必須化)**: 下記「integration 既知失敗」17件が全て解消され `tests/` 184 files / 729 tests が緑になったため、integration シャードの `continue-on-error`(観測モード)を撤廃し必須化した。
- **完了(Task 3)**: `vitest.config.mts` にカバレッジ閾値(lines 67 / branches 52、「下げる変更は禁止」コメント付き)を設定し、core シャードは `--coverage` 付きで実行。
- **完了(Task 4)**: pre-commit は `npx lint-staged`(`*.{ts,tsx,js,mjs}` → eslint --fix + prettier、`*.{json,md,yml,yaml}` → prettier)。CI lint ジョブに `format:check:ci` あり。
- **完了(Task 5)**: 主要な実 sleep テスト(data-vault / core)は `vi.useFakeTimers()` 化済み。semaphore / tier-guard-tenant に実 sleep は残っていない。
- **備考**: 60秒タイムアウト組(サブプロセス起動が本質)は timeout 維持。`format:check:ci` は歴史的未フォーマットファイルが残るため対象を package.json + workflows に限定している(全量化は Task 4-1 のフォーマット一括コミット実施後)。

## 実装タスク

### Task 1: 現状の全テスト実行と失敗棚卸し — `claude-sonnet-4`

1. ローカルで `pnpm run build` 後、`vitest run libs/actuators/`、`vitest run scripts/`、`vitest run tests/` を個別に実行し、失敗・flake・所要時間を記録する。
2. 失敗テストを「即修正可能 / 環境依存(要 secrets・ブラウザ等)/ flake」に分類し、結果表を作る。環境依存テストは vitest の `describe.skipIf(!process.env.XXX)` パターンで CI 上のスキップ条件を明示する。
3. この分類表を本文書末尾に追記する(Task 2 以降の入力)。

### Task 2: ワークフローのマトリクス拡張 — `claude-sonnet-4`

1. `package.json` のスクリプトを整理: `test:integration` を `vitest run tests/` に修正、`test:actuators`(`vitest run libs/actuators/`)と `test:scripts`(`vitest run scripts/`)を新設。
2. `ci.yml` のマトリクスを `smoke / core / actuators / scripts / integration` に拡張。Task 1 で環境依存と分類したテストが CI 上で正しく skip されることを確認する。
3. `pr-validation.yml` は速度優先で `test:core` + `test:actuators` + 境界テスト4本(`tests/foundation-io-boundary.test.ts`, `tests/core-fs-exception-boundary.test.ts`, `tests/process-boundary-governance.test.ts`, `tests/runtime-child-process-boundary.test.ts`)を必須化する。
4. `release.yml` の `validate` 後に `test:all` 相当を追加する。

### Task 3: カバレッジゲートの実効化 — `claude-sonnet-4`

1. `vitest run --coverage` をローカル実行し、現状の実測カバレッジを取得する。
2. 実測が 60% を下回る場合、閾値を「実測値の小数点切り捨て − 1pt」に設定し直し(ラチェットの起点)、`vitest.config.mts` にコメントで「IP-03 起点値、下げる変更は禁止」と明記する。
3. `ci.yml` の `unit` シャードを `--coverage` 付き実行に変更し、閾値未達で fail することを確認する。

### Task 4: format ゲートと pre-commit の実装 — `claude-haiku`

1. `pnpm format` を一度だけ全体実行し、フォーマットのみのコミットとして独立させる(レビューしやすさのため他変更と混ぜない)。
2. `ci.yml` の lint ジョブに `pnpm format:check` を追加。
3. `package.json`(または `.lintstagedrc`)に lint-staged 設定を追加: `*.{ts,tsx,js,mjs}` → `eslint --fix` + `prettier --write`、`*.{json,md,yml}` → `prettier --write`。既存の knowledge 同期エントリは維持する。

### Task 5: flaky 候補テストの安定化 — `claude-sonnet-4`

以下の実 sleep / ポーリング依存テストを、fake timers(`vi.useFakeTimers`)またはイベント待ち(完了 Promise の公開)に置き換える。挙動仕様を変えないこと。

- `libs/core/data-vault.test.ts:96,159,233,241`(5ms sleep)
- `libs/core/semaphore.test.ts:15`(5ms)
- `libs/core/core.test.ts:129`(25ms)
- `libs/core/tier-guard-tenant.test.ts:35`(25ms ポーリング)
- `libs/core/video-render-runtime.test.ts:78`、`libs/core/voice-generation-runtime.test.ts:117-123`
- `libs/actuators/video-composition-actuator/src/index.test.ts:614,685,759,772`
- 60秒タイムアウト組(`libs/core/reasoning-bootstrap.test.ts:123`、`tests/core-runtime-import-contract.test.ts:47`、`tests/a2a-lifecycle.test.ts:61,78,111`)は、サブプロセス起動が本質なら timeout 維持でよいが、共通 fixture でプロセスを再利用できないか検討する。

### Task 6: 最終レビュー — `claude-opus`

- Task 1〜5 の差分全体をレビューし、(a) CI 所要時間が PR あたり許容範囲(目安 15 分以内)か、(b) skip されたテストの理由がすべて文書化されているか、(c) ゲートの抜け道(continue-on-error 等)が無いか、を確認して所見を残す。

## リスクと注意

- 一度に全シャードを必須化すると未知の失敗で開発が止まる恐れがある。Task 2 では新シャードを最初 `continue-on-error: true` で1〜2日観測し、安定を確認してから必須化する二段階導入を許容する(ただし必須化までを本 IP の完了条件とする)。
- ブラウザ/音声系アクチュエータのテストはランナー環境に依存する可能性が高い。無理に CI で動かさず、skip 条件の明示を優先する。

## Task 1 棚卸し結果(2026-07-03 実行)

| シャード      | コマンド                                                                                                                                                                                    |                                     結果 | 対応                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------: | -------------------------------------------------------------------- |
| core coverage | `pnpm exec vitest run libs/core/ --coverage`                                                                                                                                                |            359 files / 2041 tests passed | `vitest.config.mts` に IP-03 起点の coverage thresholds を設定       |
| actuators     | `pnpm run test:actuators`                                                                                                                                                                   | 43 files / 522 tests passed / 11 skipped | `media-actuator` raw PPTX preservation の即修正を実施                |
| scripts       | `pnpm run test:scripts`                                                                                                                                                                     |              48 files / 263 tests passed | `check_tier_hygiene` の probe 汚染を避けるため sequential 化         |
| PR boundary   | `pnpm exec vitest run tests/foundation-io-boundary.test.ts tests/core-fs-exception-boundary.test.ts tests/process-boundary-governance.test.ts tests/runtime-child-process-boundary.test.ts` |                 4 files / 5 tests passed | helper 分割後の allowlist と `vault/` 除外を同期                     |
| integration   | `pnpm run test:integration`                                                                                                                                                                 |                        17 known failures | **解消済み(2026-07-04)**: 全件修正し必須化。下表は履歴として保持     |

### integration 既知失敗の分類

| 分類                                | 対象                                                                                                                            | メモ                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 契約ドリフト                        | `package-boundary-contract`, `workspace-build-contract`, `core-runtime-import-contract`                                         | `@agent/core` exports と dist 出力の不整合。IP-06/IP-14 と合わせて修正が必要      |
| 境界 baseline 更新待ち              | `governance-import-baseline`                                                                                                    | secure-io 移行・helper 分割後の import baseline 更新が必要                        |
| ドキュメント/スクリプト契約ドリフト | `release-operations-contract`, `telegram-bridge-contract`, `intent-learning-seed-cache-plan-contract`                           | 現行 script loader 規約・欠落 doc との不一致                                      |
| surface/Chronos 契約ドリフト        | `chronos-computer-sessions`, `mission-orchestration-dashboard-contract`, `runtime-surface-boundary`, `service-channel-boundary` | Chronos import 経路と Slack/service boundary コメントの配置が現行実装とずれている |
