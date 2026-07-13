# CO-04: 意思決定権限マトリクス(decision rights as data)

> 優先度: P2 / 規模: M / 依存: CO-01(会社)、CO-02(役割)、SA-05(承認) / 関連: AUTONOMOUS_MAINTENANCE_JUDGMENT(判断基準)、vision の意思決定黄金律
>
> **なぜ重要か**: 「誰が何を・どの金額/リスクまで決裁できるか」が今は散文(vision の黄金律 + 各 role の PROCEDURE.md)で、データ化・強制されていない。会社として「権限委譲と決裁」を明示的に定義・強制する層。判断基準ルーブリックの会社版。

## 背景と課題

- **決定権限が散文**: 意思決定規範は `vision/_default.md` の黄金律(Logical Integrity > Vision Alignment > Execution Speed > Adaptive Resilience)と各 role の `PROCEDURE.md` に散文で存在。承認権限は generic に強制される(Authority grant・承認ゲート)が、「どの役割が・何を・どの閾値まで決裁できるか」を束ねる**decision-rights マトリクス / 権限委譲オブジェクトが無い**。`role-authority-map.json` は write scope をマップするが、業務上の決裁閾値でない。
- 結果、「50万円までは営業が決裁、それ以上は CEO」のような会社の決裁ルールを宣言・強制できない。

## ゴール(受入条件)

1. **decision-rights マトリクスがデータ化**される: `{ decision_type, role, threshold, escalates_to }`(例: 支出承認は finance ≤50万 / CEO >50万、契約締結は legal レビュー必須、採用は CEO 決裁)。
2. mission/アクション実行時に、この決定権限が SA-05 の承認ゲート + AUTONOMOUS_MAINTENANCE_JUDGMENT の4軸判定と統合されて強制される(閾値超過は自動的に上位 role へエスカレート)。
3. vision の意思決定黄金律(優先順位)が、判断が競合した時のタイブレークとして参照される。
4. 決裁の履歴が監査(SA-01)に残り、「誰がいつ何を決裁したか」を辿れる。

## 実装タスク

### Task 1: decision-rights スキーマ — `claude-sonnet-4`

1. `schemas/decision-rights.schema.json`: `{ decisions: [{ decision_type, authorized_role, threshold: {metric, value}, requires_review_from, escalates_to }] }`。CO-02 の役割と CO-03 の財務閾値を参照。
2. `knowledge/product/governance/decision-rights.json`(会社既定)+ テナント override。schema 検証。
3. テスト: マトリクスの読み込み・検証。

### Task 2: 承認ゲートへの統合 — `claude-sonnet-4`

1. SA-05 の承認ゲート / AO-01 の ops-gate / AUTONOMOUS_MAINTENANCE_JUDGMENT §1 の4軸判定に、decision-rights を統合する: アクションの decision_type + 金額/リスクを閾値照合し、権限内なら実行、超過なら `escalates_to` の role/人間へ。
2. 判断基準の4軸(可逆/範囲/信頼/外部)に「decision-rights 上の権限有無」を加える(権限外は影響範囲を上げる = 承認へ倒す)。
3. テスト: 閾値内実行、閾値超過エスカレート、レビュー必須。

### Task 3: 黄金律のタイブレーク — `claude-sonnet-4`

1. 判断が競合した時(複数の妥当な選択肢)、vision の意思決定優先順位(Logical Integrity > Vision Alignment > Execution Speed > Adaptive Resilience、CO-01 でパース済み)をタイブレークとして参照する経路。
2. これは主に decision-support mission(MO-01 の mission class)や wisdom-actuator の decision-ops で使う。
3. テスト: 競合時に優先順位で決着すること。

### Task 4: 決裁監査 — `claude-haiku`

- 全決裁(自動/エスカレート/人間)を SA-01 の監査 + IL-02 の相関 ID で記録。SU-04 の承認キュー・AA-05 のフロー閲覧で「決裁の履歴」を辿れるようにする。

## リスクと注意

- decision-rights の誤設定は「権限過大(勝手に高額決裁)」か「権限過小(些事で毎回エスカレート)」を生む。閾値は保守的に始め、warn 観測(強制せず記録)→ enforce。判断基準の fail-closed(不明は承認へ)を維持。
- 黄金律のタイブレークは LLM 判断が絡む。決定論的な優先順位比較を第一段にし、曖昧部分のみモデル(HN-01 の tier)。恣意的なタイブレークを避け、根拠を記録。
- 完全な RACI/コーポレートガバナンスを作るのでなく、「決裁権限のデータ化 + 承認ゲートへの強制統合」に絞る。

## 実装メモ

- 2026-07-05: `knowledge/product/schemas/decision-rights.schema.json` と `knowledge/product/governance/decision-rights.json` を追加し、`libs/core/decision-rights.ts` / `libs/core/company.ts` から Company 集約経由で読めるようにした。Company dashboard でも決裁ポリシー要約を表示する。
- 2026-07-05: `libs/core/approval-gate.ts` が decision-rights を先に評価し、権限内の操作は即時許可するようにした。`libs/core/vision-resolver.ts` に黄金律優先順位ユーティリティを追加し、approval gate の監査メタデータへも流した。
- 2026-07-05: `libs/core/approval-audit.ts` を拡張し、決裁種別・相関 ID ごとの drill-down 集計を追加した。Chronos / sovereign dashboard / Company API で approval audit の要約と drill-down を表示するようにした。
- 2026-07-05: AO-01 の ops-gate 横断統合は引き続き別タスクだが、本計画の「決裁監査の詳細 drill-down」は完了した。
