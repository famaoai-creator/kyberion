---
title: 意味判断の決定論評価と未検証の意味品質
tags: [semantic-judgment, evaluation, synthetic, governance]
last_updated: 2026-10-31
---

# 意味判断の評価範囲

この成果物は T14 の合成評価データ草案と、既存オフライン判断器を通す決定論契約試験である。実モデル推論、独立した人間による正解ラベル確認、実環境 shadow は未実施。意味品質は未検証であり、実 shadow は **No-Go** のままとする。

`judgment-eval.test.ts` は `author_expected` から応答を組み立てる scripted port を明示的に使う。正例で分岐が一致しても、モデルが文章の意味を理解した証拠ではない。80 件という数も、80 の独立した業務問題や正解確認済み評価集合を意味しない。

## 固定するデータと版

データは [judgment-eval.v1.draft.json](../../tests/fixtures/judgment-eval.v1.draft.json)、試験は [judgment-eval.test.ts](../../libs/core/organization/judgment-eval.test.ts)。既存の `eval/scenarios/` は別の pipeline scenario schema を使うため、このデータをその runner の入力として扱わない。新規 generic CLI や production export は追加しない。

| 項目                                 | 固定値                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| dataset version                      | `2026-10-31-v1`                                                    |
| qualification / split                | `synthetic_draft` / `regression_draft`                             |
| label review                         | 全件 `pending_independent_human`                                   |
| prompt version                       | `semantic-judgment-offline-v1`                                     |
| rubric version                       | `semantic-judgment-mvp-v1`                                         |
| dataset UTF-8 bytes SHA-256          | `dc5f49eb703405d6e458b90f1c980c3ba6a36fdc83290465c495a563f412c95b` |
| draft rubric text SHA-256            | `ba542bf586010d005203bf191b00fd982bd5ea6cbb45d1278e13c8d13f5c29d7` |
| prompt implementation source SHA-256 | `5acb9f214dae6d7599c9f28d44baecc3739ff3fc343a42c5a5e5c8ea034bb257` |

最後の hash は `semantic-judgment.ts` の実装全体の bytes であり、各入力の完成 prompt の hash とは異なる。scripted port 内では完成 prompt の SHA-256 も計算するが、今回の試験は provider 評価結果の保存機構ではない。rubric hash はデータ作成時の判断基準草案を固定し、人間の採点承認や production prompt への追加を表さない。

apply / reframe / escalate の正例各20件、否定例20件を置く。日本語60件、英語20件で、同じ意味の言換えを含む。正例は一つの固定した遅延問題に限り、apply は既知の無料 fixture 修正、reframe は人数制限または遅延目標緩和、escalate は追加月額1000円の価値選択を扱う。出典、scope、元目標100人・p95 500ms・費用0円、測定 model/profile/seed は既存 T09 adapter から再構成する。データの自由文、作者ラベルやモデルの文面を trusted facts として採用しない。

各正例分岐は5つの paraphrase group を持ち、各groupは日本語3件・英語1件、同一の作者ラベルとpositive scenarioに固定する。否定例は20の別groupで、それぞれ一意の構造変形scenarioとunavailableラベルを持つ。試験はgroup名、分岐、scenario、operation、言語内訳の整合を確認する。自由文はUnicode NFKC・連続空白の単一化・前後空白除去後に全80件で重複を拒否する。現在の草案には否定例の同文例外も設けない。このinventory検査は言換えの意味同一性、問題の独立性や作者ラベルの正解を保証しない。

## 決定論の境界

新規試験は strict な草案 schema、件数・ID・版・hash、正例三分岐、および20の否定変形を確認する。否定例では `unavailable` の理由と実際の scripted invocation 数を照合する。構造検査、引用の現在版、有界目標の維持、予算・deadline、JSON/schema/UTF-8境界を既存 `assessSemanticJudgment` 経由で調べる。固定値40/30の token usage は fixture accounting であり、実モデルの消費測定ではない。

| 境界                                                   | 主な既存の試験責務                                      |
| ------------------------------------------------------ | ------------------------------------------------------- |
| parser、scope、欠落条件、引用、未知操作、目標/費用     | contract / validation / semantic-judgment / 新規 eval   |
| receipt の失効、新試行、同親latest、historical origin  | judgment-evidence / judgment-pre-effect                 |
| gate/charter/role/claim/approval の drift、false apply | judgment-pre-effect / judgment-latency-loop integration |
| 同一仕事、重複 event、実並行wake、effect後の未知状態   | judgment-recovery integration / executor recovery       |
| 人間 fixture、意味判断と効果承認の分離                 | judgment-human-handoff integration                      |
| 拒否後の部分publication、次回利用と既存pin維持         | judgment-learning / judgment-learning-reuse integration |
| off/shadow の業務効果非干渉                            | dot-wake-semantic-admission / observer integration      |

この表は既存試験への責務対応表であり、新規80件がすべての I/O・権限・復旧経路を再実行するという意味ではない。個別試験の実行結果と集約検査は mission evidence に分けて記録する。production parent budget adapter、実 provider の停止、実 human ingress、全 production 入口の非迂回は、この scripted 集合で成立を宣言しない。

再現コマンドは既存 Vitest の対象ファイル指定だけを使用する。

```sh
KYBERION_TEST_LEAK_STRICT=1 pnpm exec vitest run libs/core/organization/judgment-eval.test.ts --no-file-parallelism
```

## 実モデル評価への引継ぎ

現在の状態を次のように扱う。未実施の値を0や100%で埋めない。

```json
{
  "human_label_review": "not_run",
  "real_provider_evaluation": "not_run",
  "semantic_quality": "not_measured",
  "precision": null,
  "recall": null,
  "p50_latency_ms": null,
  "p95_latency_ms": null,
  "tokens_per_judgment": null,
  "real_shadow": "no_go"
}
```

実推論には provider・予算・tenant・egress の追加許可が必要。現時点では、その実行 entrypoint やコマンドを作成・確認していないため、架空の評価 CLI を記載しない。実行を許可された際には、別担当の独立した人間レビューによるラベルと不一致解消記録を固定し、provider/model ID、dataset/input/prompt/rubric hashes、費用、測定済みusage、再現回数、latency、質問率・reframe回数・保留理由を保存する。

元計画§9.2の閾値は、危険な誤適用・偽引用・scope越境・権限緩和0、未知判断のapply0、各分岐 precision95%以上・recall90%以上、正しい出典/版100%などの**提案値**であり、承認済み基準とみなさない。`unavailable` を正例20件の分母から除外せず、予測0件の precision を合格扱いしない。negative の保留率と誤適用は別集計する。

全データを作者が閲覧・言換えしているため、現在は holdout を名乗らない。調整に使用した集合は regression とし、独立担当が新規 holdout を用意する。provider/model/prompt/rubric が変われば固定版で再評価する。有害な誤適用、評価データ汚染、ラベル不一致または予算超過があれば apply は No-Go。閾値を満たしても実運用 enforce の許可にはならず、別途の限定 shadow 承認までが次の検討対象となる。
