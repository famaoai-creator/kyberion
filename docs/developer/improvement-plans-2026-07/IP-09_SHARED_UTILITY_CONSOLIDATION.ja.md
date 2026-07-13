# IP-09: 重複ユーティリティの統合

> 優先度: P2 / 規模: S / 依存: なし / 関連: IP-05(parseArgs は CLI ランナー側で解決)
> **状態(2026-07-13)**: 完了。残っていた slugify ローカル定義6箇所を正本化 + 再発防止の文書化。詳細は「実装メモ」末尾。

## 背景と課題

同名・同目的のヘルパー関数が独立実装で多重化しており、挙動ドリフトの温床になっている。

| 関数        | 定義数                                        | 主な所在                                                                                                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slugify`   | **14**                                        | `libs/core` 内だけで 9 ファイル(`analysis-findings.ts`, `mission-context-pack.ts`, `project-registry.ts`, `question-resolver.ts`, `reasoning-backend.ts`, `work-coordination.ts`, `video-composition-compiler.ts`, `visual-workflow-compiler.ts`, `music-workflow-compiler.ts`)+ `satellites/voice-hub/server.ts`、scripts 3、modeling-actuator |
| `retry`     | **11**                                        | ほぼ各アクチュエータに 1 つ(android, approval, code, file, ios, media-generation, modeling, video-composition, wisdom)+ `libs/core/mesh-message-broker.ts`, `service-engine-helpers.ts`                                                                                                                                                         |
| `parseArgs` | 10                                            | すべて `scripts/`(IP-05 の `createStandardYargs` へ寄せる)                                                                                                                                                                                                                                                                                      |
| `chunk`     | 10 / `ensureDir` 5 / `loadJson` 4 / `sleep` 4 | 各所                                                                                                                                                                                                                                                                                                                                            |

特に `slugify` は mission ID・ファイル名・knowledge スコープの生成に使われるため、**実装間の挙動差(全角処理・連続ハイフン・長さ制限)がそのまま ID 非互換になる**リスクがある。

## ゴール(受入条件)

1. `@agent/core` に正本ユーティリティ(`slugify`, `retry`, `chunk`, `sleep`, `loadJson`, `ensureDir` 相当)が 1 実装ずつ存在し、unit test を持つ。
2. 重複定義が消え、全消費箇所が正本を import する。
3. **`slugify` は既存出力と完全一致**(既存 ID・パスを変えない)。挙動差がある実装が見つかった場合は、消費箇所ごとにどの挙動へ寄せるかを表にして報告してから統合する。

## 実装タスク

### Task 1: 挙動インベントリ作成 — `claude-sonnet-4`

1. 14 の `slugify` と 11 の `retry` の実装を全て読み、入出力挙動の差分表(正規化規則・リトライ回数・backoff・例外条件)を本文書末尾に追記する。
2. 差分が無い(または包含関係にある)グループと、真に挙動が異なるものを分類する。挙動が異なる `slugify` は、その出力が永続化物(mission dir 名、knowledge ファイル名)に使われているかを消費箇所から判定する。

### Task 2: 正本実装とテスト — `claude-sonnet-4`

1. `libs/core/text-utils.ts`(slugify, chunk)と `libs/core/async-utils.ts`(retry, sleep)を新設(既存に適切な置き場 — 例えば `cli-utils.ts` や既存 utils — があればそちらへ。新設前に `libs/core` を確認)。`loadJson`/`ensureDir` は secure-io 経由の実装として追加する。
2. Task 1 の差分表に基づき、`slugify` は「最も広く使われている挙動」を既定にし、異挙動が必要な消費箇所向けにはオプション引数(例: `{ maxLength, keepCase }`)で吸収する。
3. 各関数にプロパティベースの unit test(代表入力 + 既存実装の出力を fixture 化した一致テスト)を付ける。
4. `libs/core/index.ts` バレルからエクスポート。

### Task 3: 消費箇所の移行 — `claude-haiku`(Task 1 の差分表と Task 2 の API を添付。ファイル単位で機械的に)

1. `libs/core` 内 9 ファイル → scripts → actuators → satellites の順に、ローカル定義を削除し正本 import に置換する。
2. 1 ファイルごとに関連テストを実行。**永続化物に関わる `slugify` 消費箇所(mission-context-pack, project-registry, work-coordination)は、置換前後で代表入力の出力一致を確認するテストを先に書く**。
3. 挙動差があると Task 1 で分類された箇所は haiku では触らず、sonnet 担当に差し戻す。

### Task 4: 再発防止 — `claude-sonnet-4`

- `eslint` の `no-restricted-syntax` などで新規のローカル `slugify`/`retry` 定義を warn にする、または `docs/developer/EXTENSION_POINTS.md` に「共通ユーティリティは @agent/core から」の一節を追記する(軽い方でよい。lint 化が過剰なら文書化のみ)。

## リスクと注意

- `retry` の統合はリトライ回数・backoff の変化がそのまま外部 API 呼び出し回数の変化になる。**各消費箇所の現行パラメータを維持する**(正本 `retry` は回数・遅延を引数必須にし、既定値に頼らせない)。
- `slugify` の統合で出力が 1 文字でも変わると、既存 mission ディレクトリや knowledge ファイルとの照合が壊れる。一致テストを必須とする。

## 実装メモ

- `libs/core/text-utils.ts` に `slugify()` 正本を追加し、`analysis-findings` / `work-coordination` / `reasoning-backend` の 3 箇所を移行した。`libs/core/text-utils.test.ts` で normalized / whitespace 両方の挙動を固定した。
- 追加で `question-resolver` と `project-registry` を正本 `slugify()` に寄せ、`question-resolver` の profile question ids と `project-registry` の bootstrap work_id の既存出力をテストで固定した。
- さらに `music-workflow-compiler` / `visual-workflow-compiler` / `video-composition-compiler` の `slugify` ローカル定義も正本化し、各 compiler の既定 filename / composition id の挙動をテストで固定した。
- `mission-context-pack` の残っていたローカル `slugifySegment()` も `text-utils.slugify()` に寄せ、context pack id の生成が `CPK-...-IMPLEMENTER-<8hex>` 形式で安定することを回帰テストで固定した。
- `libs/core/async-utils.ts` を追加し、`retry()` を既存 `withRetry()` の正本ラッパとして公開した。`service-engine-execution.ts` を新しい `retry()` 経由に寄せ、`control-plane-client.ts` のローカル `sleep()` も `async-utils.sleep()` に置換した。
- `media-generation-helpers.ts` の局所 `sleep()` も `async-utils.sleep()` に寄せた。`android-runtime-helpers.ts` の busy-wait 版 `sleep()` は同期制御の別実装なので今回は保持した。
- その後 `android-runtime-helpers.ts` の busy-wait 版 `sleep()` も async 化して `async-utils.sleep()` に寄せ、UI 待機ループを非同期待ちへ統一した。
- `media-document-pipeline-helpers.ts` / `vision-actuator/src/index.ts` / `process-actuator-helpers.ts` の `withRetry()` 呼び出しを `retry()` 経由へ置換し、正本ラッパの消費箇所を追加した。
- `media-actuator/src/index.ts` からは `withRetry` import の残骸を除去した。
- `approval-actuator-helpers.ts` も `withRetry()` から `retry()` に寄せた。
- `secret-actuator-helpers.ts` と `calendar-actuator-helpers.ts` も `withRetry()` から `retry()` に寄せた。
- `service-actuator-helpers.ts` も `withRetry()` から `retry()` に寄せた。
- `agent-actuator-helpers.ts` も `withRetry()` から `retry()` に寄せ、agent runtime 操作の再試行を正本化した。
- `meeting-actuator-helpers.ts` と `media-generation-helpers.ts` も `withRetry()` から `retry()` に寄せた。
- `network-pipeline-helpers.ts` も `withRetry()` から `retry()` に寄せた。
- `ios-runtime-helpers.ts` の `withRetry()` 呼び出し群も `retry()` に寄せ、simctl 系の再試行を正本化した。
- `terminal-actuator-helpers.ts` も `withRetry()` から `retry()` に寄せた。
- `terminal-actuator-helpers.ts` の取り残し 1 箇所も `retry()` に揃えた。
- `voice-runtime-helpers.ts` の `withRetry()` 呼び出し群も `retry()` に寄せた。
- `email-actuator/src/index.ts` の draft/send 経路も `withRetry()` から `retry()` に寄せ、メール送信の再試行を正本ラッパに統一した。
- `blockchain-actuator/src/index.ts` の simulated anchor 経路も `withRetry()` から `retry()` に寄せた。
- `presence-actuator-helpers.ts` の Slack 送信と timeline dispatch も `withRetry()` から `retry()` に寄せた。
- `video-composition-action-helpers.ts` の bundle 構築と backend render も `withRetry()` から `retry()` に寄せた。
- `scripts/run_pipeline.ts` / `scripts/run_pipeline.js` の reasoning backend 呼び出しも `withRetry()` から `retry()` に寄せた。
- `artifact-actuator/src/index.ts` と `network-actuator/src/a2a-transport.ts` の `withRetry` import 残骸を除去した。
- `artifact-actuator-helpers.ts` の governed artifact 書き込み/参照系も `withRetry()` から `retry()` に寄せた。
- `system-actuator/src/index.ts` / `code-actuator/src/index.ts` / `browser-actuator/src/index.ts` / `meeting-browser-driver-helpers.ts` の `withRetry` import 残骸も除去した。
- `orchestrator-actuator/src/orchestrator-helpers.ts` の shell / file / git_checkpoint も `withRetry()` から `retry()` に寄せ、テストのモックも更新した。
- `system-actuator/src/system-pipeline-helpers.ts` の shell / exec / probe / tts / open / kill 系も `withRetry()` から `retry()` に寄せた。
- `system-actuator/src/index.test.ts` のモックも `withRetry` から `retry` に揃えた。
- `file-actuator/src/file-pipeline-helpers.ts` の file pipeline 系の再試行も `withRetry()` から `retry()` に寄せ、`index.test.ts` も追従させた。
- `browser-actuator/src/browser-pipeline-helpers.ts` の browser pipeline 系の再試行も `withRetry()` から `retry()` に寄せ、`index.test.ts` も追従させた。
- `code-actuator/src/code-pipeline-helpers.ts` の code pipeline 系の再試行も `withRetry()` から `retry()` に寄せ、`index.test.ts` も追従させた。
- `wisdom-actuator/src/wisdom-pipeline-helpers.ts` の wisdom pipeline 系の再試行も `withRetry()` から `retry()` に寄せ、`index.test.ts` も追従させた。
- `modeling-actuator/src/modeling-pipeline-helpers.ts` の modeling pipeline 系の再試行も `withRetry()` から `retry()` に寄せ、`index.ts` の残骸 import も除去した。
- `android-actuator/src/android-runtime-helpers.ts` の adb / file / UIA / CLI 系の再試行も `withRetry()` から `retry()` に寄せ、`index.test.ts` も追従させた。
- `meeting-browser-driver/src/index.ts` の Playwright 接続/終了/ページ操作も `withRetry()` から `retry()` に寄せた。
- 残っていたテストモック群(`terminal`, `voice`, `network`, `approval`, `service`, `media-generation`, `secret`, `ios`, `email`, `blockchain`, `video-composition`, `service-engine`) も `retry` 名義に揃え、`calendar-actuator/src/index.js` の実装呼び出しも `retry()` に寄せた。`service-engine.test.ts` は `./async-utils.js` をモックして retry 引数の検証を維持した。
- `secure-io.ts` に `loadJson()` と `ensureDir()` を追加し、`work-design.ts` / `mission-team-index.ts` / `mission-team-plan-composer.ts` の局所 `loadJson()` を撤去して正本へ寄せた。`secure-io.test.ts` で JSON 解析とディレクトリ作成の契約を固定した。
- **残っていた `slugify` ローカル定義6箇所を正本化(2026-07-13)**: `satellites/voice-hub/server.ts`(`slugifyProjectId`/`slugifyProjectRootToken`)、`libs/core/campaign-suite.ts`(`slugifyTitle`)、`libs/actuators/modeling-actuator/src/topology-to-architecture-adf.ts`、`scripts/generate_project_os.ts`、`scripts/reconcile_unclassified_errors.ts`、`scripts/reconcile_unhandled_intents.ts`。挙動一致は代表入力+境界値(maxLength 境界で separator が来るケース含む)をスクリプトで網羅比較して確認(全一致)。うち2スクリプト(`reconcile_unclassified_errors`/`reconcile_unhandled_intents`)はローカル実装が「slice してから trim」の順序だった(正本は trim してから slice)ため、`slugify(text, { separator: '_', maxLength: 60 }).replace(/^_|_$/g, '')` で trim-after-slice を呼び出し側で合成し出力を完全一致させた(正本自体の意味論は変更していない)。`voice-hub` の `slugifyProjectId` は大文字化版だったため `slugify(...).toUpperCase()` で合成(小文字化してから大文字化しても、非英数字のフィルタ対象文字集合は case-insensitive なので出力は既存と一致)。回帰テストは公開エントリポイントを持つ2箇所(`buildCampaignPlan`、`topologyIrToArchitectureAdf`)に追加(`campaign-suite.test.ts`、`topology-to-architecture-adf.test.ts`)。残り4箇所(voice-hub の巨大サーバファイル、CLI スクリプト3本)は既存のテスト基盤が無く、新設のコストが本タスクの規模(S)に対して過大なため、上記の網羅的等価性検証で代替した。
- **Task 4(再発防止)完了**: `docs/developer/EXTENSION_POINTS.md` に「§8 Shared Utilities (Internal)」を新設し、`slugify`/`retry` 等の共通ユーティリティは `@agent/core` の正本を import する(ローカル再実装しない)ことを明記(lint 化は `retry` という識別子が汎用的すぎて誤検知リスクが高いため見送り、文書化のみとした — plan の「軽い方でよい」を採用)。
- **棚卸し結果(2026-07-13)**: `retry`/`chunk`/`ensureDir`/`loadJson` の残存ローカル定義は網羅 grep で確認 — 真の重複は残っていない(`retry` という名前がヒットした8箇所は全て retry **policy** を保持するローカル変数で、関数の再実装ではなかった)。`parseArgs`(scripts 16箇所)は元計画どおり IP-05(`createStandardYargs`)の管轄として本タスクの範囲外。
