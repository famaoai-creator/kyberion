# OP-01: LLM コスト会計と予算上限

> 優先度: **P0** / 規模: M / 依存: IP-13(モデルID一元化)推奨 / 関連: 評価レポート V-7-02/03「FDE 信頼のため API コスト集計を可視化せよ」、構想評価 §5「経営者価値の指標を K 系に追加」
>
> **なぜ重要か**: FDE 業態では「この自動化はいくらかかるか」に答えられることが商談の前提。かつ暴走コストの上限が無いのは 30 日連続運用の実運用リスク。

## 背景と課題

コスト会計の部品は揃っているのに、**主要経路が計測していない・集計が誰にも呼ばれない・上限が効かない**。

- **直接 Anthropic SDK 経路がコストを記録しない**(最大の穴): `libs/core/anthropic-reasoning-backend.ts` は `metrics` を import せず、`callParse` が返す `usage` ブロックも捕捉しない。**この経路の消費は完全に不可視**。一方 claude-agent(Agent SDK)経路は記録する(`claude-agent-query.ts:37-55`、`sdk_cost_usd` は `total_cost_usd` 由来 `:135`)。
- **予算/上限が効かない**: `costCapTokens`(`reasoning-backend.ts:66`)は**プロンプト文字列として注入されるだけ**(`anthropic-reasoning-backend.ts:443`、`claude-agent-reasoning-backend.ts:395`)。超過時に中断・throttle・拒否する仕組みは無い。日次/ミッション単位の spend ceiling も皆無。
- **集計 API が誰にも呼ばれない**: `metrics.ts` の `reportFromHistory()`/`summarize()`/`detectRegressions()` は実装・テスト済みだが**呼び出し元ゼロ**。`totalCostUSD` はメモリ内で算出され捨てられる。per-mission コストロールアップも無い。(**分担 2026-07-03**: 本計画は `reportFromHistory`/`summarize` による**コスト集計**を所有。`detectRegressions()` の**劣化検知**配線は OP-04 が所有 — 重複しない。)
- **コストの二重ソース**: `record()` はトークン×レジストリで再計算(`metrics.ts:185`)、Agent SDK は `total_cost_usd` も返す(未使用)→ ドリフト可能性。
- コストレジストリ(`knowledge/product/governance/model-cost-registry.json`)とレート解決(`resolvePer1kRate`)は良くできている。

## ゴール(受入条件)

1. **全推論経路**(直接 Anthropic SDK / claude-agent / gemini / codex)がトークン + コストを `metrics.record()` に記録する。
2. **ミッション単位・日次のコストロールアップ**が集計され、`pnpm cost report [--mission <id>] [--since <date>]` と operator packet / 週次サマリ(KM-01)で可視化される。
3. **予算上限が実効**: ミッション単位・日次の spend ceiling(設定可能)を超えると、次の推論呼び出しが**ブロックまたは承認要求**になる(プロンプト注入でなく実制御)。
4. コストのソースが単一化される(Agent SDK の実コストがある場合はそれを正、無ければトークン×レジストリ)。

## 実装タスク

### Task 1: 直接 SDK 経路のコスト計測 — `claude-sonnet-4`

1. `anthropic-reasoning-backend.ts` に `metrics` を import し、`callParse` の応答 `usage`(input/output tokens)を捕捉して `metrics.record({ component, tokens, model, mission_id })` を呼ぶ。model ID は IP-13 の一元管理経由。
2. gemini(`gemini-cli-backend.ts`)/ codex 経路も同様に、可能な範囲で usage を捕捉(CLI が返さない場合はトークン概算 + `estimated: true` フラグ)。
3. mission_id / correlation_id(AA-05)を record に伝搬し、ミッション単位集計を可能にする。
4. test: 各 backend が record を呼ぶこと(usage モック)、estimated フラグ。

### Task 2: 集計とレポート — `claude-sonnet-4`

1. `metrics.ts` の `reportFromHistory()`/`summarize()` を呼ぶ `scripts/cost_report.ts` を新設: `work/metrics/execution-metrics.jsonl` を走査し、ミッション別・モデル別・日別の tokens/USD を集計。`pnpm cost report` として公開。
2. コストのソース単一化: `record()` で Agent SDK 実コスト(`sdk_cost_usd`)があればそれを採用、無ければトークン×レジストリ(ドリフト解消)。
3. operator packet と KM-01 週次サマリに「今週のコスト: $X(ミッション別内訳 top3)」を追加。
4. test: fixture メトリクスからの集計正確性、ソース優先順位。

### Task 3: 予算上限の実効化 — `claude-sonnet-4`

1. `libs/core/spend-guard.ts` を新設: ミッション単位・日次の累計コストを追跡(`work/metrics` または専用 state)、上限(`knowledge/product/governance/spend-policy.json`、ミッション既定 + テナント override)を超えたら次の推論呼び出しを `SpendCapExceededError` でブロック or 承認要求。
2. `getReasoningBackend()` の呼び出し前(or backend 内の共通前処理)に spend-guard チェックを挟む。`costCapTokens` のプロンプト注入は補助として残すが、実制御はガードが担う。
3. 上限は warn(超過を通知するが通す)→ enforce の段階導入(既定 warn)。
4. test: 上限超過でブロック/承認、warn/enforce、テナント override。

### Task 4: KPI 接続 — `claude-haiku`

- 評価レポートが参照する(実在しない)`KPI_TRACKING.md` の代わりに、`cost report` の出力を FDE 向け KPI(ミッションあたりコスト・月次スパン)として `docs/` の適所に定義。構想評価 §6 提言の「経営者価値の指標」の 1 つとして位置づける。

## リスクと注意

- spend-guard のブロックは**作業を途中で止め得る**。ミッション単位上限は寛容な既定(大きめ)から始め、warn で実測分布を見てから締める。中断時は「上限到達。承認で継続 or 上限引き上げ」の明確な導線(UX-01/UX-04)を出す。
- コスト計測の追加で推論のホットパスにオーバーヘッドが乗らないよう、record は非同期 append(既存 metrics の仕組み)に留める。
- 見積り(estimated)と実測を混ぜた集計は誤解を生む。レポートで estimated 分を明示分離する。

## 実装状況 (2026-07-12)

**全4タスク完了 — 受入条件4点を充足。**

- **Task 1(全経路計測)/ Task 2.1-2(cost report・ソース単一化)/ Task 3.1-3(spend-guard 本体)**: 2026-07-11 実装済み(STATUS 参照)。
- **Task 2.3 完了(2026-07-12)**: operator packet / status report に「今週のコスト」を追加 — `status_snapshot_to_report` が `buildCostReportFromHistory(直近7日)` を集計し、findings `weekly-cost`(合計 USD・呼び出し数・ミッション別 top3・estimated 分離)と metrics `weekly_cost_usd` を出力。コスト集計の失敗は status 報告を壊さない(swallow して省略)。KM-01 週次サマリは 2026-07-11 配線済み。
- **Task 3 テナント override 完了(2026-07-12)**: `spend-policy.json` の `tenant_overrides`(従来はプレースホルダで未参照)を実効化 — `resolveSpendPolicyForTenant()` がテナント(引数 or `KYBERION_TENANT`)の cap/posture を base に上書き。`checkSpendGuard` に `tenantId` オプション追加、アラート dedupe キーにテナントを含める。テスト4本追加(適用・未知テナント・block 執行・base 温存)。
- **Task 4 完了(2026-07-12)**: 評価レポートが参照していた実在しない `KPI_TRACKING.md` を実体化(`docs/KPI_TRACKING.md`)— FDE 向けコスト KPI(ミッションあたり・週次/月次スパン・日次バーン)を `pnpm cost:report` に接続して定義。
