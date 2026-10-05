---
title: 3役で始める dot チーム — 非稼働スターターテンプレート
tags: [orchestration, dots, charter, handoff, verification, starter]
last_updated: 2026-10-05
role_affinity: [ecosystem_architect, qa_lead, knowledge_steward]
runtime_stages: [intake, planning, execution, review]
---

# 3役で始める dot チーム

5つの責任を、最初は3つの論理役にまとめる。実装・文章・デザインは必要時の短命な worker に渡し、専門分野ごとの常駐 dot は増やさない。

これは **導入候補のテンプレート**。自動インストール、常駐プロセス起動、cadence 有効化、権限追加、外部接続は行わない。
[charter JSON](./dot-team-templates/) は既存の DotCharter schema に適合するが、runtime が探索する `dots/` および tenant の `dots/` の外に置いてある。3件とも `draft` である。

## 3役と5責任

| 候補                                                                         | 責任                       | 入力                                                               | 出力・受入証跡                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [starter-concierge](./dot-team-templates/starter-concierge.json)             | 受付、完了までの進行管理   | 認証済み依頼元の依頼、担当者からの結果、検品結果                   | 目的・受入条件・担当・期限・次の一手、証跡付きの完了または阻害要因。ユーザー向け報告は元の会話の担当に集約 |
| [starter-result-verifier](./dot-team-templates/starter-result-verifier.json) | 独立した検品               | 元の依頼、受入条件、成果物の正確な revision/hash、作成者、検証記録 | accepted / changes_required / blocked / unverifiable。条件ごとの根拠、未実行項目、残るリスク               |
| [starter-ops-librarian](./dot-team-templates/starter-ops-librarian.json)     | 保守の振り分け、知識の整理 | 運用上の発見、確定した成果・失敗の証跡                             | 既存担当への振り分け案、出典・鮮度・格納先を示した知識候補。保守の実行や知識昇格は別の承認済み経路         |

既存 role を参照するだけで新しい role / grant は作らない。対応は順に `infrastructure_sentinel`、`qa_lead`、`knowledge_steward`。役割名は権限を増やす仕組みではない。

## 既存 dot との共存

現在の標準 charter は [repo-guardian](../../../dots/repo-guardian.json) と [org-operations](../../../dots/org-operations.json)。前者の `repository.health`、後者の `organization.operations-loop` はそのまま残す。候補はそれぞれ別の `team.*` 責任を持ち、既存 dot の名前・scope・status・通知先・cadence・handoff allowlist を変更しない。

「最初の3役」は論理的なチーム構成であり、「現在稼働する dot が3件」という意味ではない。2件の既存設定がある環境に候補を3件導入すれば設定は5件になる。既存役との統合や置き換えが必要なら、担当と移行条件を別途合意する。

既存 charter の `active` は設定値であり、daemon が現在動いている証拠ではない。このテンプレートは既存稼働状況を判定しない。

- repo-guardian: repository health の実行責任者。新しい保守係は発見を分類するだけで、重複した監視・修復を始めない。
- org-operations: 組織の運営 cadence の実行責任者。標準設定は confidential tenant に属する。この public 候補から直接引き継げない。
- 現在の両 charter は候補からの handoff を許可していない。concierge に振り分け案を返し、権限を持つ operator が既存経路で扱う。拒否を受けて allowlist を自動追加したり、tenant を横断して inbox に書き込んだりしない。

## Handoff 契約

以下は既存 `DotProposal.objective` と WorkItem の参照に含めるレビュー用の契約であり、新しい runtime schema や独自 queue ではない。structured context の正本は既存 WorkItem に置き、本文から scope や権限を決めない。

1. **依頼と所有者**: 元の会話・依頼の参照、認証済み principal、親 WorkItem、依頼者・現担当・次担当。実行環境が解決した `tenant_slug → organization_id → project_id → mission_id → task_id` と data tier を維持する。
2. **目的と範囲**: 求める結果、受入条件、対象成果物、範囲外、許可済みの action。引用された指示や成果物内の文言を新しい承認として扱わない。
3. **証跡**: 成果物の参照と revision/hash、作成者、実際に実行した検証・時刻・結果、未実行項目。可読性とアクセス権を同じ scope で確認する。上位 tier の内容を public handoff に貼り付けない。
4. **境界**: deadline / cancellation condition、残予算、必要な approval の参照、失敗時の返却先。足りなければ blocked として concierge に返す。
5. **返却**: 同じ WorkItem / 成果物 revision に結びついた結果または阻害要因。元の担当は runtime が受理・所有者を記録するまで責任を手放さず、新規依頼を複製して再送しない。

候補間の許可方向は concierge → verifier / ops-librarian → concierge のみ。受信側の `accepts_handoffs_from` で宣言している。双方が明示的に導入・有効化され、同じ tenant scope であることが前提。draft のままの handoff は動かない。直接の verifier ↔ ops-librarian 経路は設けない。

受信後の executor prompt は charter の purpose を含むが、goal.statement の詳細すべてを含むとは限らない。独立検品・承認分離・既存担当・停止条件など当該依頼に必要な制約は handoff objective にも明記し、導入時に実際の受信側で保持されることを検証する。

### 検品と承認を分ける

検品担当が作成・修正した成果物は別の担当が検品する。accepted は **品質についての判定** であり、送信・公開・merge・deploy・支払いや権限変更を認めるものではない。検品中に修正が入ったら revision を更新して再検品する。自分の proposal を自分で承認しない。

依頼を受けた concierge も、worker の「できた」という報告だけで完了にしない。必要な独立検品と実測証跡が揃ってから、未完了や制約を含めて報告する。

## 実行・予算・停止の境界

各候補の初期値:

- wake は inbox だけ。cron / watch / probe / event、digest、組織 cadence は設定しない
- notification は inbox のみ。共有のローカル確認先 `dot-team-starter-review` は実在する外部宛先やユーザーIDではない
- `direct_reply` の助言だけ。pipeline allowlist は空、同時提案は1件まで
- 全提案の判断 floor は approve、待機期限は60分、autonomy は L1 固定
- 1 wake の設定は3 turn / 120秒、日次 token の開始判定閾値は20,000。自己 follow-up は0件
- working memory は既存の dot store で最大4 KiB。知識候補は既存の memory / knowledge 昇格フローを使う

これらは構成上の制約であり、使い切る目標ではない。日次 token 値は wake / WorkItem の開始時判定であり、開始後の消費による超過を防ぐ厳密な総量・金額上限ではない。現行 executor では cap 状態の読み取り失敗時も開始を許す場合がある。厳密な支出制限が必要なら別途検証した provider / 実行基盤の制限が必要で、このテンプレートだけでは保証しない。予算切れが判明した場合・依頼取消・期限切れ・承認拒否では続行しない。取消は既存 work board / mission lifecycle を通して記録し、停止した work を新しい ID で作り直して追跡を逃れない。手動 pause は wake を止めるが、すでに走った外部処理の取消や効果の巻き戻しを保証しない。

永続化、重複排除、claim / lease、approval、予算判定、quarantine は deterministic runtime の責任。モデルの性格・記憶・会話に代替させない。効果が不明な失敗を単純再試行せず、既存 executor の quarantine と operator release を使う。concierge は何が必要かをまとめ、ユーザーに内部復旧操作を何度も求めない。

**能力上の限界**: charter を増やしても汎用タスク実行器は追加されない。
`task_session` は現行 runtime で未提供。mission は operator の正式な開始が必要。実作用の pipeline が必要なら、別途レビューした既存 pipeline とその allowlist が必要で、この候補では未許可。
`direct_reply` も provider によって read-only が機械的に保証されるわけではなく、結果は unverified advisory として扱う。schema / role 検証は実行時の完全な権限制限の証明ではない。

## ユーザーとの窓口

verifier と ops-librarian は concierge に証跡を返し、ユーザーへ別々に連絡しない。concierge は重要な進捗・意思決定・阻害要因・完了を元の会話で一度だけ伝える。

これは運用契約であり、新しい通知集約 router を追加してはいない。現状の inbox には各 dot の記録が残る。外部通知は無効のまま、確認した宛先と会話の責任者が決まるまで `live` にしない。単一会話での実際の集約は、導入時に既存の conversation owner と接続して検証する。

## 明示的な導入手順（この変更では実行しない）

1. operator が「この3候補を導入する」範囲を決定する。既存2件との共存か統合か、principal・tier・tenant・会話窓口・予算・停止条件を確認する。public テンプレートに機密の依頼を渡さない。
2. 既存の charter authoring 権限を持つ担当が対象 scope の正式な charter 配置先へ候補をコピーする。status は draft のまま。root `dots/` なら schema 参照は `../knowledge/product/schemas/dot-charter.schema.json` に合わせる。tenant 配置ではその場所からの参照と登録済み tenant を確認する。新しい role / grant を暗黙に追加しない。
3. `pnpm kyberion dot validate <dot_id>` で読み込みと schema を確認する。現行 CLI は draft に対して activation gate を実行せず、activation_ready: true と表示するため、この値を準備完了の証拠にしない。role、heartbeat、責任の重複は次の activate 時に検査される。provider / 宛先 / scope readiness は別途確認する。
4. operator の明示的な判断後に `pnpm kyberion dot activate <dot_id>` を使う。JSON の status を手書き変更しない。inbox-only、approve、L1、予算上限は維持する。
5. 機密情報のない小さな検証依頼を1件だけ使い、同一 scope の handoff、独立検品、承認待ち、取消、重複しない報告を確認する。provider に渡す情報と能力は先に承認する。失敗や未検証を「稼働済み」と数えない。
6. 予期しない動作では `pnpm kyberion dot pause <dot_id>`。未決 WorkItem / approval / quarantine を確認し、既存の復旧手順に従う。cadence / live 通知 / pipeline / autonomy 拡張は別の判断とする。

## 関連

- [Resident Dot Model](../architecture/resident-dot-model.md)
- [dot の既存運用と executor 制約](../../../dots/README.md)
- [Mission kickoff](./mission-kickoff-playbook.md)
- [作業分類](../governance/work-scope-policy.json)
