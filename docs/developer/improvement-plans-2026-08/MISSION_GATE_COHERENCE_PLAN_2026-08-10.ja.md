---
title: MISSION GATE COHERENCE PLAN 2026 08 10
tags: [improvement-plan, 2026-08]
last_updated: 2026-08-25
status: active
---

# MG: ミッションゲート整合計画 — 切り分け基準の一本化とゲート実効化

> 優先度: **P1** / 規模: M / 依存: EG-06(WorkItem context スキーマ執行)、IL-05(shape 正準化) / 後続: 個人タスク実行形の定義(**保留中** — 下記スコープ外)
>
> 起点: 2026-08-10 の「ミッション/プロジェクト化する作業と個人実行タスクの切り分け」調査。ガバナンス文書側とコード側の並行調査により、切り分けの**仕組みは存在するが整合していない**ことを確認した。本計画はその是正のみを扱い、「個人タスク」という新しい実行形の導入は operator 判断待ちとして**含めない**。

## 背景 — 調査で確認した3系統の問題

切り分けの正本は2次元モデル([mission-task-classification-roadmap-5.4-mini](../../../knowledge/product/architecture/mission-task-classification-roadmap-5.4-mini.md) §3): `execution_shape` の単調な6段ラダー(`direct_reply → actuator_action/browser_session → task_session → pipeline → mission → project_bootstrap`)と、必須トリガー(1つで mission)+蓄積トリガー(2つで mission)の昇格ルール。これは [work-scope-policy.json](../../../knowledge/product/governance/work-scope-policy.json) + `libs/core/work-scope-decision.ts` として機械化され、`libs/core/surface-runtime-orchestrator.ts:1531` に強制点(`mission_controller create` の自動起票+ガバナンスレシート)まで実装済みである。問題は正本自体ではなく、その周辺にある。

### A. 機械ゲートが実運用で機能していない(コード)

| #   | 問題                                                                                                                                                                                                                                                                                                                    | 証跡                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A-1 | **必須トリガー付き `direct_reply` が昇格されない**。`shouldPromoteToMission` は `routeFamily === 'task_session' \|\| 'pipeline'` のときしか昇格せず、正本の「昇格は単調・必須トリガーは無条件」と矛盾                                                                                                                   | `surface-runtime-orchestrator.ts:1215-1220`(判定は `:1219`)                                      |
| A-2 | **昇格判定への信号が未給電**。蓄積トリガー入力(`artifactEstimate`、`crossSystemMutation`、`expectedContinuationBeyondSession` 等15種)は `work-design.ts:611-625` に配線済みだが、本番呼び出し元2箇所はどちらも `requiresApproval` しか渡さない。閾値2のため単独では決して発火せず、実昇格はカタログ静的下限のみで決まる | `intent-contract.ts:1256-1273`(`buildFallbackWorkLoop`)、`assistant-compiler-request.ts:444-457` |
| A-3 | **デッドトリガー**。`high_stakes_action` はポリシーに宣言されているが `deriveMandatoryTriggers` が一度も emit しない                                                                                                                                                                                                    | `work-scope-policy.json:8` vs `work-scope-decision.ts:96-108`                                    |
| A-4 | 「直接やったがミッションにすべきだった」を検出する lint・分類器が皆無(最も近い `classifyOrganizationWork` は dry-run 専用・未接続)                                                                                                                                                                                      | `organization-operating-model.ts:830-921`、`scripts/organization_operating_model.ts:353`         |

### B. 判定基準が文書間で矛盾(ドキュメント)

| #   | 問題                                                                                                                                                                                                                                                                                   | 証跡                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| B-1 | **`alignment.md` は無条件ミッション必須**。「Alignment 後は MUST `mission_controller start`」でサブゲートの分岐がなく、AGENTS.md L32 の条件付きゲートと正面衝突。Alignment は `all_clear` の毎セッション入口なので、文字通り読むと毎セッション必ずミッション                           | `knowledge/product/governance/phases/alignment.md:28-32`                                           |
| B-2 | **「外部/規制向け」の重みが二重定義**。AGENTS.md では5条件の1つ(もう1条件必要)、ポリシーでは単独必須トリガー                                                                                                                                                                           | `AGENTS.md` §2 vs `work-scope-policy.json:6-15`                                                    |
| B-3 | **ゲート未達時のフォールバックが3通り**。AGENTS.md「ad-hoc Write/Edit まで可」/ intent-catalog「one-shot pipeline」/ PRODUCTIZATION_ROADMAP「迷ったら mission に上げる」                                                                                                               | `AGENTS.md` §2 / `kyberion-intent-catalog.md:428-438` / `docs/PRODUCTIZATION_ROADMAP.md:361-396`   |
| B-4 | **デッド参照「Rule 7」**。存在しない番号付きルールを2文書が引用し、旧5条件形式のまま(必須トリガー精緻化を反映していない)                                                                                                                                                               | `kyberion-intent-catalog.md:430`、`knowledge/public/procedures/system/developer-onboarding.md:135` |
| B-5 | **閾値の欠落**。PRODUCTION_GOAL_INSTRUCTIONS は5条件を「≥2」なしで列挙し any-one-of に読める                                                                                                                                                                                           | `docs/developer/PRODUCTION_GOAL_INSTRUCTIONS.ja.md:44`                                             |
| B-6 | **`reconcile-work` 適用範囲が2つの幅**。OPERATOR_UX_GUIDE「**別のガバナンス経路**で完了した作業のみ」vs execution.md「オーナーが**直接**やるのが common case、それを採用」。実運用(distill)は広い方に従っている                                                                        | `docs/OPERATOR_UX_GUIDE.md:589-592` vs `phases/execution.md:66-68`                                 |
| B-7 | **authority と mission の関係が未定義**。agent-mission-control-model は「agent の権限は mission に由来する」と断言する一方、AUTHORITY_MODEL は SYSTEM/SOVEREIGN モードにミッション不要の広域書き込み権を与える。`ecosystem_architect` セッションをどちらが統治するかを述べる文書がない | `agent-mission-control-model.md:18-21` vs `AUTHORITY_MODEL.md:24-48`                               |
| B-8 | ドメイン独自ゲートが正本を参照しない(multi-agent-development-sop の フル/簡略スキップ、adf-pipeline-validation-plan の any-1-of-4)                                                                                                                                                     | `multi-agent-development-sop.md:16-20`、`adf-pipeline-validation-plan.md:124-133`                  |

### C. 語彙の衝突(スキーマ/データ)

| #   | 問題                                                                                                                                                                                                                                                                                                 | 証跡                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C-1 | **`work_shape` という名前が2つの互換性のない語彙を持つ**。work item の 6値(組織運営 vs ソリューション開発の軸)と、`intent-coverage-matrix.json` の `direct_reply`/`mission` 等(実体は `execution_shape` の誤名 — `intent-coverage-contract.test.ts:63` が `intent.resolution.shape` と同値を assert) | `knowledge/product/schemas/governed-work-item.schema.json:40-56` vs `knowledge/product/governance/intent-coverage-matrix.json` |
| C-2 | **context chain の表記順が文書間で異なる**。AGENTS.md / GLOSSARY は `organization_id → tenant_slug → …`、正準の entity-scope-hierarchy は `tenant_slug → organization_id → …`。「フィールド列挙順であり包含順ではない」という disclaimer は ORGANIZATION_VIEW_SCOPE_ARCHITECTURE:35 にしかない       | `AGENTS.md` §1 / `docs/GLOSSARY.md:357` vs `entity-scope-hierarchy.md:12`                                                      |

## 方針

1. **正本を一本化し、他文書は再記述をやめてリンクにする。** 判定基準の正本は 5.4-mini の2次元モデル + `work-scope-policy.json` の2点のみ。AGENTS.md を含む他の全文書は「必須/蓄積の2段形式の要約+正本リンク」に置換し、5条件形式の再記述を禁止する(lint で再発防止)。
2. **コードはポリシーへ整合させ、ポリシーを弱める方向の解決はしない。** A-1 は routeFamily 制限の撤廃(実装修正)、A-3 は導出の実装(宣言の削除ではなく)。
3. **信号給電は保守的に始める。** 呼び出し元が確実に知っている信号(承認要否、外部向け、セッション超え継続、カタログ由来のメタデータ)のみ伝播し、推定値をでっち上げない。偽陽性昇格(軽量要求の誤ミッション化)は偽陰性より害が大きい。
4. **「個人タスク」の設計判断を先取りしない。** 本計画は既存語彙・既存ゲートの整合に限定する。

## ゴール(受入条件)

1. 必須トリガーを持つ要求は routeFamily に関わらず昇格判定を受け、golden シナリオ(`mission-task-classification-scenarios`)で「必須トリガー付き direct_reply → mission」「蓄積1 → 非昇格」「蓄積2 → 昇格」「catalog floor 非降格」が固定される。
2. `work-scope-policy.json` に宣言された全トリガー id が derive 実装から到達可能であることを静的突合 checker が検証し、CI 登録される(A-3 の再発防止)。
3. 本番呼び出し元2箇所(`intent-contract.ts` / `assistant-compiler-request.ts`)が蓄積トリガー信号を伝播し、テストで実証される。
4. `alignment.md` にサブゲート分岐が存在し、「毎セッション mission start 必須」と読める記述が消える。
5. 「Rule 7」参照と旧5条件形式の再記述が repo から消え、ドキュメント lint が再発を検出する。
6. `intent-coverage-matrix.json` のフィールドが `execution_shape` に改名され、GLOSSARY に Execution Shape の項が追加され、contract test が更新される。
7. `reconcile-work` の適用範囲記述が execution.md と OPERATOR_UX_GUIDE で一致する。
8. AGENTS.md / GLOSSARY の context chain 表記に「フィールド列挙順(包含順の正本は entity-scope-hierarchy)」の1行 disclaimer が入る。
9. 新規 checker/テストは registration ceremony([kyberion-development-practices](../../../knowledge/product/governance/kyberion-development-practices.md))に従い CI 登録される。

## 実装フェーズ

### Phase 1 — ゲート実効化(コード、P1)

- **MG-01 `direct_reply` 昇格漏れ修正**: `surface-runtime-orchestrator.ts:1215-1220` の routeFamily 制限を撤廃し、`promotion_required` が立てば `direct_reply`/`actuator_action`/`browser_session` でも昇格させる。ガバナンスレシート(`:1234-1252`)の `matched_rule_ids` はそのまま。境界 golden シナリオを classification-scenarios へ追加。
- **MG-02 デッドトリガー解消+宣言/導出突合 checker**: `deriveMandatoryTriggers` に `highStakesAction` 入力を追加して `high_stakes_action` を到達可能にする。あわせて「policy 宣言トリガー ⊆ derive 実装が emit しうる集合」を検証する静的 checker を governance check 群へ登録(受入条件2)。
- **MG-03 昇格信号の給電**: `buildFallbackWorkLoop`(`intent-contract.ts:1256`)と `assistant-compiler-request.ts:444` から、intent contract / catalog metadata から**確実に導出できる**蓄積トリガー(`externalAudience`、`expectedContinuationBeyondSession`、`crossSystemMutation`、`replayOrVariantLikelihood`)を `buildOrganizationWorkLoopSummary` へ伝播。導出不能な信号は未指定のまま。`mismatch_reason`(`work-design.ts:695-703`)の発火をテストで確認。

### Phase 2 — 文書正準化(P1)

- **MG-04 AGENTS.md の基準をポリシーと同型化**: §2 のミッションゲート項を「必須トリガー(1つで mission)/蓄積トリガー(2つで mission)」の2段形式+正本リンクに書き換え(B-2 解消)。ラダー最下段(ad-hoc Write/Edit)が正当である旨は維持。
- **MG-05 `alignment.md` サブゲート分岐**: 「昇格判定が mission 未満なら task_session/direct で進み、`mission_controller start` は実行しない」分岐を追加(B-1 解消)。`_Status: Mandated by AGENTS.md_` と実際の AGENTS.md の関係を整合。
- **MG-06 デッド参照・旧形式の一掃**: intent-catalog の「Rule 7」+ one-shot pipeline フォールバック、developer-onboarding の「Rule 7」、PRODUCTION_GOAL_INSTRUCTIONS の閾値欠落、PRODUCTIZATION_ROADMAP の「迷ったら mission」を「必須トリガーの疑義があれば mission、なければラダー最下段」へ条件付け(B-3/B-4/B-5 解消)。multi-agent-development-sop / adf-pipeline-validation-plan の独自ゲートには「正本ゲートのドメイン適用である」旨と正本リンクを追記(B-8)。
- **MG-07 `reconcile-work` 適用範囲の統一**: execution.md の広い読み(オーナー直接作業の採用が common case)を正本とし、OPERATOR_UX_GUIDE:589-592 を「ミッション内で直接完了した作業、または dispatch 前の governed path で完了した作業」に修正(B-6 解消)。
- **MG-08 語彙衝突の解消**: `intent-coverage-matrix.json` の `work_shape` フィールドを `execution_shape` へ改名し、`intent-coverage-contract.test.ts` と生成/消費側を全域 grep で更新(C-1)。GLOSSARY に Execution Shape の項を追加し Work Shape との違いを1行で明記。AGENTS.md / GLOSSARY の context chain に列挙順 disclaimer を追加(C-2)。
- **MG-09 authority と mission gate の優先関係の明文化**: `agent-mission-control-model.md` §1 に「mission 外の書き込み権限は AUTHORITY_MODEL の ExecutionMode(system/sovereign)が定義し、ミッションゲートは mode に関わらず作業の**形**(execution_shape)を決める」旨の1段落を追加。AUTHORITY_MODEL 側からも相互リンク(B-7 解消 — 個人タスクの新概念は導入しない)。

### Phase 3 — 再発防止(P2)

- **MG-10 ドキュメント lint**: 「Rule 7」等の AGENTS.md 死参照パターンと、5条件旧形式の再記述(正本リンクなしの基準列挙)を検出する軽量チェックを governance checker 群へ追加・CI 登録。

## ミッションゲート判定(dog-food)

本計画の実装は、成果物 5+(文書8+・コード4+・checker/テスト)、再実行・変種あり(Phase 単位の適用)、複数視点(ガバナンス設計と実装の両面)で**必須ではないが蓄積 ≥2 が成立**する。着手時はミッションを起票し、本計画を紐付けて Phase ごとに checkpoint を切る。

## リスク

| リスク                                                      | 緩和                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| MG-01/03 で昇格が増え、軽量要求が誤ってミッション化される   | 給電は確実に導出できる信号のみ(方針3)。golden シナリオで非昇格境界(蓄積1)も固定。`mismatch_reason` の発火状況を導入後に観測 |
| AGENTS.md の基準変更が全 agent の行動に波及                 | 変更は「ポリシーと同型化」のみで新基準を発明しない。正本(5.4-mini / policy JSON)は不変更                                    |
| `intent-coverage-matrix` 改名で生成/消費側の見落とし        | フィールド名の全域 grep + contract test 更新をセットで実施。schema があれば minor bump                                      |
| alignment.md の緩和が「アライメントなしで実行」に誤読される | 分岐はミッション起票の有無のみ。意図合意・Zero Physical Change の原則は shape に関わらず維持することを明記                  |

## スコープ外(保留・別計画)

- **個人タスクの明示的実行形** — operator 判断待ち(2026-08-10)。以下は本計画で**触らない**: `work_shape` への personal/ad-hoc 値の追加、`work-coordination.ts:372` の `|| 'routine_operation'` 黙殺デフォルトの廃止、`management_unit: task_session` に対応する `work_shape` の定義、`active/personal/` のモデル化、personal-todo 運用層の再建([VOLATILE_KNOWLEDGE_PLAN](../../VOLATILE_KNOWLEDGE_PLAN.ja.md) 参照)。
- **mission ticket dispatch → work store の実接続**(`solution_project` 実データ0件問題)— [LIFECYCLE_SMOOTHNESS_PLAN](./LIFECYCLE_SMOOTHNESS_PLAN_2026-08-08.ja.md) の context chain 接続、および [ENTITY_GOVERNANCE_UNIFICATION_PLAN](./ENTITY_GOVERNANCE_UNIFICATION_PLAN_2026-08-09.ja.md) の WorkItem context 執行の管轄。
- 3系統の shape authority の実行時正準化の残件 — IL-05 の管轄。

## 実装状況

2026-08-10 に MG-01〜MG-10 を実装済み。`check:work-scope-policy` は policy の mandatory trigger 7件が導出層へ到達可能であることを確認し、`check:mission-gate-docs` は正準文書9件から旧 Rule 7 / 5条件表現が消えていることを確認する。個人タスクの明示的実行形は計画どおりスコープ外のまま保留する。
