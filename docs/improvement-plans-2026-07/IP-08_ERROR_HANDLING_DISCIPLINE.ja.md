# IP-08: エラーハンドリング規律(握りつぶし catch・浮遊 Promise・process.exit)

> 優先度: P1 / 規模: M / 依存: IP-05 推奨(共通ランナーが CLI 層のエラー処理を吸収するため先行が効率的)

## 背景と課題

- **例外の握りつぶしが 137 箇所**(空 catch 104 + コメントのみ catch 33)。ホットスポット: `scripts/agent_runtime_supervisor_daemon.ts`(8)、`libs/core/surface-response-blocks.ts`(8)、`presence/bridge/terminal/server.ts`(7)、`libs/core/secret-guard.ts`(5)、`libs/core/secure-io.ts`(4)。
- **`secure-io.ts:178-184` のポリシーゲートが fail-open**: `[POLICY_BLOCKED]` 以外の例外(ポリシーファイルの parse 失敗等)を握りつぶして「許可」に倒れる。ガバナンスの静かな無効化。
- **`run_baseline_check.ts:48-53`** が接続準備設定の parse 失敗を silent に既定値へ落とし、L5 信頼チェックが緩い側に倒れる。
- **library コードに console.\* が 115 箇所**(構造化 `logger` があるのに素通し。`libs/core/doctor_core.ts` 22、`skill-wrapper.ts` 9 など)。Trace ベースのガバナンスが前提とする構造化ログから漏れる。
- **モジュール深部の `process.exit`**: CLI ガード以外に約13箇所(`libs/core/skill-wrapper.ts:129,134`、`core.ts:347`、`voice-actuator/src/index.ts:747`、`media-actuator/src/index.ts:2623`、`file-actuator/src/file-pipeline-helpers.ts:339` ほか)。ライブラリとして import された時にプロセスごと落とす。
- **浮遊 Promise**: `satellites/voice-hub/server.ts:1431,3850,3895` の `void 実行(...)` / `.then()` に `.catch` 無し。プロセスレベルの `unhandledRejection` ハンドラも actuators/satellites/presence に存在しない。長寿命 bridge サーバの安定性リスク。
- `scripts/run_super_pipeline.ts:43` の `main()` に `.catch` が無い(`run_pipeline.ts:862-866` は正しく処理している)。

## ゴール(受入条件)

1. ポリシーゲート・ベースラインチェックの silent fail-open が「**挙動は維持しつつ必ず警告ログを出す**」形になる(fail-closed への変更は本 IP では行わず、判断を要する箇所として報告に残す)。
2. 空 catch 137 箇所が triage され、(a) 正当(クリーンアップ等)→ 理由コメント付き `catch { /* reason */ }`、(b) 要ログ → `logger.warn` + コンテキスト、(c) バグ → rethrow or 修正、のいずれかに分類・処置される。
3. `libs/` の console.\* が `logger` 経由に置き換わる(CLI の結果出力・doctor 系の対話出力は除外可。除外一覧を残す)。
4. ライブラリ深部の `process.exit` が「例外 throw + CLI 層(IP-05 ランナー)での exit」に置き換わる。
5. voice-hub の浮遊 Promise に `.catch` が付き、長寿命サーバ(voice-hub / presence bridge / satellites)に `unhandledRejection` / `uncaughtException` の記録ハンドラが入る。

## 実装タスク

### Task 1: ガバナンス系 silent failure の可視化(最優先・最小 diff)— `claude-sonnet-4`

1. `secure-io.ts:178-184`: catch 節に `logger.warn('[secure-io] policy evaluation failed, allowing by default', { path, error })` を追加(挙動は不変)。同様の fail-open が secure-io 内に他に無いか確認(`:204-205`, `:348-349` はクリーンアップ系なので理由コメント化)。
2. `run_baseline_check.ts:48-53`: parse 失敗時に stderr 警告を出し、レポート JSON に `config_degraded: true` を含める。
3. `run_super_pipeline.ts:43`: `main().catch(...)` を `run_pipeline.ts:862-866` と同形に修正。
4. それぞれ既存/新規テストで確認(IP-07 Task 3 と整合)。

### Task 2: 空 catch の triage 台帳作成 — `claude-sonnet-4`

1. `grep -rn "catch\s*(\?\w*\)\?\s*{\s*}" ...`(あるいは AST ベースで `eslint no-empty` を一時有効化)により 137 箇所を列挙し、ファイル・行・分類(a/b/c)・処置を表にして本文書末尾へ追記する。
2. 分類 (c)(バグ疑い)だけは即修正せず、内容を報告して人間の確認を仰ぐ。

### Task 3: triage の実施 — 分類(a)(b)は `claude-haiku`(台帳を添付、機械的置換)/ 分類(c)は `claude-sonnet-4`

- (a) は理由コメントの付与のみ。(b) は `logger.warn(文脈, { error })` への置換(該当モジュールが logger を import していなければ追加)。1 ホットスポットファイルごとに関連テストを実行。
- 完了後、`eslint.config.js` に `no-empty: ['error', { allowEmptyCatch: false }]` 相当を有効化して再発を防ぐ(理由コメント付き catch は空でないため通る)。

### Task 4: console.\* → logger 移行 — `claude-haiku`(除外リスト付き)

1. 除外: `doctor_core.ts`(対話診断ツール)、`test-utils.ts`、examples 配下、CLI の最終結果出力(IP-05 ランナー内)。
2. それ以外の `libs/` 内 console.\* を `logger.info/warn/error` へ置換。`skill-wrapper.ts`、`shared-vision/src/vision-judge.ts`、`video-composition-compiler.ts`、singleton 系(`terminal-bridge.ts` 等)が主対象。
3. `pnpm test:unit` で確認。

### Task 5: process.exit の除去 — `claude-sonnet-4`

1. CLI エントリガード(`if (直接実行) { main().catch(() => process.exit(1)) }`)は正当なので**残す**。
2. モジュール深部の 13 箇所(背景節に列挙)を、意味のあるエラー型の throw に置換し、呼び出し元 CLI 層で exit させる。`skill-wrapper.ts:129,134` から着手し、1 ファイルごとに関連テスト実行。
3. 置換後、`eslint` の `no-restricted-syntax` で `process.exit` を `libs/**`(index.ts の CLI ガードを除く)に対し warn 設定し、再発を可視化する。

### Task 6: 長寿命サーバの Promise 安全化 — `claude-sonnet-4`

1. `satellites/voice-hub/server.ts:1431,3850,3895` に `.catch(err => logger.error('[voice-hub] detached task failed', err))` を付与。同型の `void xxx(...)` を同ファイル内で全数確認する。
2. voice-hub・4 つの satellite bridge・`presence/bridge/terminal/server.ts`・`presence-studio/server.ts` の起動部に、`process.on('unhandledRejection')` / `process.on('uncaughtException')` でログ記録するハンドラを追加(既定はログのみ、プロセスは落とさない)。共通化できる場合は `@agent/core` に `installProcessGuards(name)` として実装し各所から呼ぶ。

## リスクと注意

- **fail-open → fail-closed の変更は絶対に本 IP で行わない**。ポリシーゲートを fail-closed にすると正常運用が突然止まり得る。本 IP は「見える化」まで。fail-closed 化は警告ログの観測結果を持って別途判断する。
- console → logger 置換で出力先が変わるため、ログを文字列パースしている呼び出し元(pipelines の shell ステップ)が無いか、置換対象ごとに grep で確認する。

## 実装メモ

- `scripts/run_super_pipeline.ts` のトップレベル `main().catch(...)` にエラーメッセージの正規化を入れ、`trace.addEvent('super_pipeline.failed', ...)` も `err.message` 依存のまま落ちないようにした。
