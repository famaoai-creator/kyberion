# IP-09: 重複ユーティリティの統合

> 優先度: P2 / 規模: S / 依存: なし / 関連: IP-05(parseArgs は CLI ランナー側で解決)

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
