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

## 実装状況 追記 (2026-07-12)

- **再突合**: Task 1 は概ね解消済みを確認 — secure-io の fail-open は SA-05 で fail-closed 化(本 IP の「警告して通す」を超える処置)、run_baseline_check は parse 失敗警告 + `config_degraded` フラグ実装済み、run_super_pipeline の main catch も実装メモどおり処置済み。voice-hub の浮遊 Promise(Task 6.1)も全 `.then` チェーンに `.catch` 付与済みを確認。
- **Task 6.2 完了(今回)**: `libs/core/process-guards.ts` を新設(`installProcessGuards(name)` — unhandledRejection / uncaughtException を記録、プロセスは落とさない・冪等)。**9つの長寿命プロセス**へ配線: voice-hub / slack・discord・imessage・telegram の4ブリッジ / terminal-bridge / presence-studio / nexus-daemon / agent-runtime-supervisor daemon。テスト2本。
- 残: 空 catch 137 箇所の triage 台帳(Task 2/3)と console→logger 移行(Task 4)、process.exit 除去(Task 5)— いずれも機械的横展開のため別スライス。

## 空 catch triage 台帳(2026-07-12, Task 2 成果物)

機械抽出(`catch {}` 完全空のみ): **94 箇所**。コメントのみの catch **202 箇所**は理由が明文化済みのため分類 (a) 相当として台帳対象外。
ヒューリスティック一次分類: **(a) 正当(クリーンアップ/テスト期待例外) 32** / **(b) 要ログ付与 49** / **(c) ガバナンス経路・要人間確認 13**。

- 分類は文脈キーワードによる一次判定であり、(c) は修正前に必ず人間が確認する(Task 2.2)。
- 処置の横展開: **分類 (b) 49箇所は 2026-07-12 に全件 logger.warn 付与済み**(制御フロー不変、握りつぶし内容の可視化のみ)。残るは (a) への理由コメント付与(任意)。
- (c) の代表例: `libs/core/secret-guard.ts`(5箇所)、`libs/core/tier-guard.ts`(3箇所)、`libs/core/trust-engine.ts`。これらは「ガード失敗を握りつぶして許可側に倒れていないか」の観点で個別レビューする。

| ファイル                                                            | 行   | 分類 | 処置                                          |
| ------------------------------------------------------------------- | ---- | ---- | --------------------------------------------- |
| `libs/actuators/android-actuator/src/android-runtime-helpers.ts`    | 1100 | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/actuators/browser-actuator/src/browser-pipeline-helpers.ts`   | 1403 | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/actuators/media-actuator/src/artisan/ppt-engine.ts`           | 70   | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/actuators/modeling-actuator/src/modeling-pipeline-helpers.ts` | 628  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/actuators/service-actuator/src/service-actuator-helpers.ts`   | 159  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/actuators/service-actuator/src/service-actuator-helpers.ts`   | 191  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/actuators/service-actuator/src/service-actuator-helpers.ts`   | 365  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/actuators/system-actuator/src/system-pipeline-helpers.ts`     | 789  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/actuators/system-actuator/src/system-pipeline-helpers.ts`     | 829  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/agent-adapter.ts`                                        | 356  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/agent-adapter.ts`                                        | 379  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/agent-adapter.ts`                                        | 490  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/agent-runtime-supervisor-client.ts`                      | 179  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/agent-runtime-supervisor-client.ts`                      | 195  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/agent-runtime-supervisor-client.ts`                      | 225  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/approval-cowork-adapter.test.ts`                         | 138  | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/authority.ts`                                            | 282  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/authority.ts`                                            | 319  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/core.ts`                                                 | 182  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/core.ts`                                                 | 260  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/core.ts`                                                 | 281  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/core.ts`                                                 | 328  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/detectors.ts`                                            | 48   | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/dynamic-permission-guard.ts`                             | 46   | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/email-workflow.ts`                                       | 161  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/email-workflow.ts`                                       | 171  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/email-workflow.ts`                                       | 628  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/fs-utils.ts`                                             | 38   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/fs-utils.ts`                                             | 75   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/metrics.ts`                                              | 527  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/nerve-bridge.ts`                                         | 63   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/nerve-bridge.ts`                                         | 96   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/network.ts`                                              | 26   | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/oauth-session-store.ts`                                  | 51   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/oauth-session-store.ts`                                  | 96   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/oauth-session-store.ts`                                  | 99   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/peer-conversation.test.ts`                               | 25   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/peer-messaging.test.ts`                                  | 37   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/secret-guard.ts`                                         | 74   | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/secret-guard.ts`                                         | 266  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/secret-guard.ts`                                         | 296  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/secret-guard.ts`                                         | 306  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/secret-guard.ts`                                         | 342  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/secure-io.ts`                                            | 258  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/secure-io.ts`                                            | 262  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/secure-io.ts`                                            | 445  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/secure-io.ts`                                            | 448  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/sensory-memory.ts`                                       | 30   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/service-engine-execution.ts`                             | 63   | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/service-engine-execution.ts`                             | 101  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/service-engine-helpers.ts`                               | 38   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/service-preset-registry.ts`                              | 136  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/service-preset-registry.ts`                              | 147  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `libs/core/src/pfc/ServiceValidator.ts`                             | 222  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/tenant-registry.test.ts`                                 | 41   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/tenant-registry.test.ts`                                 | 45   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/tier-guard-tenant.test.ts`                               | 55   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/tier-guard.ts`                                           | 45   | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/tier-guard.ts`                                           | 531  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/tier-guard.ts`                                           | 547  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/trust-engine.ts`                                         | 231  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/trust-engine.ts`                                         | 252  | (c)  | 要人間確認(ガバナンス経路の握りつぶし疑い)    |
| `libs/core/unclassified-error-registry.ts`                          | 104  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/unhandled-intent-registry.ts`                            | 135  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `libs/core/untrusted-content.test.ts`                               | 30   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/core/untrusted-content.test.ts`                               | 51   | (a)  | テスト内の期待例外 — 現状維持可(コメント推奨) |
| `libs/shared-network/src/mcp-client-engine.ts`                      | 68   | (a)  | 理由コメント付与(クリーンアップ系)            |
| `presence/bridge/nexus-daemon.ts`                                   | 200  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `presence/bridge/terminal/server.ts`                                | 196  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `presence/bridge/terminal/server.ts`                                | 233  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `presence/bridge/terminal/server.ts`                                | 258  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `presence/bridge/terminal/server.ts`                                | 310  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `presence/bridge/terminal/server.ts`                                | 319  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `presence/bridge/terminal/server.ts`                                | 331  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `presence/bridge/terminal/server.ts`                                | 352  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts`    | 106  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `presence/displays/operator-surface/src/lib/data.ts`                | 383  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `presence/displays/operator-surface/src/lib/data.ts`                | 397  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `satellites/voice-hub/server.ts`                                    | 1138 | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/agent_runtime_supervisor_daemon.ts`                        | 90   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/control_plane_cli.ts`                                      | 758  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/control_plane_cli.ts`                                      | 766  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/control_plane_cli.ts`                                      | 784  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/control_plane_cli.ts`                                      | 792  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/mission_journal.ts`                                        | 44   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/refactor/mission-lifecycle.ts`                             | 61   | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/refactor/mission-llm.ts`                                   | 382  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/refactor/mission-seal.ts`                                  | 55   | (a)  | 理由コメント付与(クリーンアップ系)            |
| `scripts/refactor/mission-state.ts`                                 | 227  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/refactor/mission-state.ts`                                 | 244  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/refactor/mission-state.ts`                                 | 246  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/run_pipeline.ts`                                           | 460  | (b)  | logger.warn 付与済み(2026-07-12)              |
| `scripts/surface_runtime.ts`                                        | 150  | (a)  | 理由コメント付与(クリーンアップ系)            |
| `scripts/surface_runtime.ts`                                        | 160  | (a)  | 理由コメント付与(クリーンアップ系)            |
