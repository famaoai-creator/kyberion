# IP-07: クリティカルパスへのテスト追加

> 優先度: **P0** / 規模: M / 依存: なし / 後続: IP-10(分割は特性化テスト後)

## 背景と課題

不変条件・ガバナンスゲート・課金経路という「壊れると最も痛い」モジュールほどテストが無い。

| 対象                                                    | 規模    | 現状                                                                                                                 |
| ------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `libs/core/adf-repair-agent.ts`(`validateAndRepairAdf`) | —       | **テストゼロ**。AGENTS.md §1 が必須と定める ADF 修復カスケード(JSON修復→LLMサブエージェント→`safeWriteFile`)が未検証 |
| `libs/core/anthropic-reasoning-backend.ts`              | 705行   | テストゼロ(実トークンを消費する経路)                                                                                 |
| `libs/core/claude-agent-reasoning-backend.ts`           | 608行   | テストゼロ                                                                                                           |
| `libs/core/codex-cli-reasoning-backend.ts`              | —       | テストゼロ                                                                                                           |
| `scripts/check_contract_schemas.ts`                     | 4,969行 | **`validate` ゲートの一部なのにテストゼロ**                                                                          |
| `scripts/run_baseline_check.ts`                         | —       | セッション開始ゲート、テストゼロ。設定破損を silent に既定値へ落とすバグあり(`:48-53`、IP-08 対象)                   |
| `libs/core/surface-runtime-orchestrator.ts`             | 1,844行 | 部分テストのみ(delegation/fastpath)。リクエスト経路全体の配線に対する特性化テスト無し                                |
| `libs/core/operator-learning.ts`                        | 1,100行 | テストゼロ                                                                                                           |
| `libs/core/tier-guard.ts`                               | 549行   | 隣接テストのみ                                                                                                       |

## ゴール(受入条件)

1. `validateAndRepairAdf` のカスケード全分岐(有効入力素通し / JSON 軽量修復で直る / LLM 修復まで行く / 修復不能)がスタブ backend でテストされる。
2. 3 つの推論アダプタが、トランスポート(HTTP/CLI 呼び出し)をモックした状態で「リクエスト整形・レスポンス解釈・エラー分類・リトライ」をテストされる。
3. `check_contract_schemas` と `run_baseline_check` に golden/fixture ベースのテストが付く。
4. `surface-runtime-orchestrator` に主要経路の特性化テストが付き、IP-10 の分割の安全網になる。
5. 追加テストはすべて `KYBERION_REASONING_BACKEND=stub` で決定論的に動く(実 API 呼び出し禁止)。

## 実装タスク

### Task 1: adf-repair-agent のテスト — `claude-sonnet-4`

1. `libs/core/adf-repair-agent.ts` と `libs/core/validate.ts`・`json-repair.ts` を読み、修復カスケード(`:38-50`)の分岐を把握する。
2. `libs/core/adf-repair-agent.test.ts` を新設し、`stubReasoningBackend`(`reasoning-backend.test.ts` の既存パターンを踏襲)で以下をテスト:
   - 有効な ADF → 修復なしで素通り
   - 軽微な JSON 破損(末尾カンマ等)→ `json-repair` 層で修復され、LLM が**呼ばれない**こと
   - 構造破損 → スタブ LLM の修復結果が採用され `safeWriteFile` されること(書き込み先は一時 fixture)
   - スタブが修復不能な出力を返す → 失敗が分類されて返り、**壊れた契約が書き込まれない**こと
3. 実行: `vitest run libs/core/adf-repair-agent.test.ts`。

### Task 2: 推論アダプタ 3 本のテスト — `claude-sonnet-4`(1 アダプタずつ順に)

1. 各アダプタのトランスポート層(anthropic: SDK/HTTP クライアント、claude-agent: `@anthropic-ai/claude-agent-sdk`、codex: CLI spawn)を `vi.mock` で差し替える。
2. 共通テスト観点: (a) 正常レスポンスの構造化結果への変換、(b) タイムアウト/レート制限エラーの分類、(c) リトライ回数と backoff の遵守、(d) モデルID・パラメータがリクエストに正しく載ること(IP-13 のモデルID一元化の回帰網にもなる)。
3. 既存の `shell-claude-cli-backend.test.ts` をスタイル見本にする。

### Task 3: ゲートスクリプトの golden テスト — `claude-sonnet-4`

1. `scripts/check_contract_schemas.test.ts`: `tests/golden/` の慣例に従い、(a) 現行リポジトリで exit 0、(b) 故意に壊した契約 fixture(`active/shared/tmp/` 配下に生成)で exit 非0・違反メッセージに fixture 名が含まれる、の 2 系統。4,969 行の内部は触らず入出力契約のみ固定する(内部分割は IP-10)。
2. `scripts/run_baseline_check.test.ts`: L0-L6 の各レイヤを個別に強制失敗させられる seam があるか確認し、無ければ「全 pass で status=passed の JSON が出る」「設定ファイル破損時の挙動」の 2 ケースから始める(後者は IP-08 での修正後に期待値を更新)。

### Task 4: surface-runtime-orchestrator の特性化テスト設計 — `claude-opus`

1. `libs/core/surface-runtime-orchestrator.ts`(1,844行、40+ モジュール import)を読み、外部から観測可能な主要経路(意図受領→mission team 組成→task session→delegation→応答)を 5〜8 本のシナリオとして定義する。
2. 各シナリオについて「入力・スタブすべき境界・観測すべき出力/副作用」を表にした試験設計を本文書末尾に追記する。**実装はしない**(設計のみ)。

### Task 5: 特性化テストの実装 — `claude-sonnet-4`(Task 4 の設計表に従う)

- 既存の `surface-runtime-orchestrator.delegation.test.ts` / `.fastpath.test.ts` のセットアップを再利用し、Task 4 の設計どおりに実装する。1 シナリオ 1 テストで、実装内部のリファクタに耐える粒度(公開 API と副作用のみ検証)を守る。
- 余力があれば `operator-learning.ts` に同様の baseline テスト(学習エントリの記録・取り出しの往復)を追加する。

## リスクと注意

- スタブ backend の応答形式が実 API と乖離すると「テストは緑だが本番で壊れる」形になる。Task 2 では実レスポンスのサンプル(既存ログ/型定義から復元)を fixture 化し、スタブに流用すること。
- `check_contract_schemas` はリポジトリ全体を走査するため、テストが遅くなりやすい。fixture ディレクトリを限定できる引数が無い場合は、走査ルートを引数化する最小変更(±20行程度)を許容する。
