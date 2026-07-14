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
- 2026-07-14 精査: Task1/2/4 は実装+テスト21本緑(decision-rights.test.ts / approval-gate.test.ts / vision-resolver.test.ts / approval-audit.test.ts)を確認。**Task3 は未了と判明**: `resolveGoldenRulePriorityOrder`(vision-resolver.ts)は `approval-gate.ts` の監査メタデータへ付与されるのみで、本タスクが要求する「decision-support mission / wisdom-actuator の decision-ops での競合タイブレーク」経路には接続されていない(`decision-ops.ts` に参照なし)。次の一手: wisdom-actuator の意思決定系 op(例: 複数選択肢を比較する decision-ops)に golden-rule 優先順位での決定論的タイブレークを組み込み、競合解決テストを追加する。
- 2026-07-14 Task3 実装完了: `vision-resolver.ts` は `@agent/core`(`libs/core/index.ts`)から一切 export されておらず、wisdom-actuator(別パッケージ)から到達不能だったのが接続されていなかった真因。`export * from './vision-resolver.js'` を追加した上で、`libs/actuators/wisdom-actuator/src/decision-ops.ts` に `resolveHypothesisConflict` op(`resolve_hypothesis_conflict`)を新設: hypothesis-tree-protocol.md Phase C(収束)で複数仮説が `survived: true` のまま残った場合(=判断の競合)、`resolveGoldenRulePriorityOrder(resolveVision(tenant_slug))` の優先順位で決定論的に勝者を選ぶ。各仮説は任意で `golden_rule_dimension` を宣言でき、未宣言は最下位ランクとして無条件勝利を防止。同順位同士は入力配列の順序で安定決着(恣意性を避ける)。`op-catalog.ts` の apply op 一覧・`dispatchDecisionOp` の switch に登録、`decision-ops.test.ts` へ4テスト追加(単独生存者はconflict=false、既定優先順位でのタイブレーク、未タグ仮説の劣後、同順位時の安定決着)。
  - **既知の残課題(スコープ外・別チケット向け)**: `resolveGoldenRulePriorityOrder` 自体は、テナント vision のステアリング文言に golden-rule 語彙が含まれるかどうかのゲートとして働くだけで、実際の並び替え(`order.sort(compareGoldenRulePriority)`)は常に固定 canonical order を返す no-op になっている(`compareGoldenRulePriority` が `GOLDEN_RULE_PRIORITY` の固定インデックスのみで比較するため)。つまり「テナントごとに優先順位をカスタマイズできる」という設計意図は現状未達成 — Task3 のタイブレーク経路自体は正しく配線されているが、上流の順序計算がテナント文言に反応しないままなので、テナント固有の優先順位は今のところ機能しない。修正には「文言中の言及順序を実際に読み取って order を並べ替える」実装が必要で、CO-04 の範囲を超えるため本チケットでは着手しない。
