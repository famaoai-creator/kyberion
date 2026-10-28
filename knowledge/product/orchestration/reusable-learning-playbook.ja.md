---
title: 依頼を再利用可能な知識・スキル・pipeline に育てる
tags: [learning, skills, aidlc, pipeline, promotion, reuse]
last_updated: 2026-10-28
---

# 依頼から再利用へ

作業を実行し、結果を検証してから、再利用する部分を選ぶ。判断知識は
knowledge / playbook / skill、安定した実行手順は pipeline、browser/service
recording は ProcedureCatalog に昇華する。未確定の試行は mission evidence
に残す。AI-DLC はこの仕事を進める lifecycle であり、新しい学習 lifecycle
や候補ストアを別に持たない。

## 改善候補を作る

```bash
pnpm kyberion learning prepare \
  --input active/shared/tmp/public/shared/example/lesson.md \
  --intent "同じ手順を再利用する" --title "再利用する手順" \
  --destination knowledge --reuse-when "同じ前提の依頼を処理するとき" \
  --verify "pnpm <既存の検証コマンド>" --dry-run --json
```

`--mission <id>` は当該 scope の蒸留/retrospective evidence を使う。
`--run <adf-file>` は pipeline 候補の入口であり、成功証明を意味しない。
実行 context が scope の正本で、CLI に tenant 認可を上書きする引数はない。
`--verify` はレビュー用の記述であり、このコマンドは実行しない。

planner は既存資産を検索して `extend_existing` / `replace_existing` /
`create_new` / `no_change` を返し、対象の base digest と理由を残す。
`--replace-target` は明示された読み取り可能な対象だけを置換候補にする。
候補作成は公開でも承認でもない。dry-run を外しても既存 candidate registry
に review 待ちとして保存するだけである。第三者 plugin の install は既存の
provenance gate を通す。

準備した候補を既存の memory review に渡すには、表示された候補 ID を使う。

```bash
pnpm kyberion learning prepare --queue --candidate <DSC-LEARN-ID> --json
pnpm mission memory-review <返されたmemory-candidate-id>
```

引き渡し先は未分類・steward review 必須の候補である。source と target の
digest が変わっていれば review/公開時に拒否される。domain の分類と内容の
curation は別途必要。skill/pipeline 向けの計画もまず手順の review に渡し、
実際の資産更新は対応する承認・昇格経路で行う。候補の反復回数で承認しない。

## pipeline を昇格する

```bash
pnpm pipeline --input <adf-file>
pnpm pipeline:promote --input <同じadf-file> --run <engine-run-id> --no-llm
# 未実証の案は実行 catalog 外に保存する
pnpm pipeline:promote --input <adf-file> --draft --no-llm
```

tenant の ADF には既存の `--tenant <slug>` と project-trust 承認が必要。
mission の run は `--mission <id>` も指定する。保護された journal の完了、
全 step 成功、source digest、scope、trace binding が一致しなければ昇格しない。
旧 journal で証明不能なら再実行する。`--trace` だけでは成功証明にならない。

`verified_source` は元の ADF の実行成功。抽象化後の `contract_sha256` は
別の版であり、schema/guardrails の検証を通っても実行成功とは区別する。
登録済み repository template の配布は `unverified_template`。配布時に外部
作用を実行せず、既存の project-trust gate を維持する。

## 実績を確認する

```bash
pnpm kyberion learning reuse --input <公開済みのasset-file> --json
```

ADF は契約を検証して pipeline journal を参照し、JSON の recording や知識は
knowledge verification ledger を参照する。必要なら `--kind knowledge|pipeline|procedure`
で用途を明示できる。拡張子だけで pipeline と判定しない。

新しい候補ストアは作らず、既存 knowledge verification ledger と engine
run journal から、同じ版・選択 scope の実績を投影する。知識配信、worker
の完了報告、独立した golden success check を分ける。配信だけでは成功を
計上しない。pipeline については engine の完了証跡であり、業務成果の
独立評価とは区別する。件数は保持範囲内の観測で、打ち切りは明示される。

Chronos の KnowledgeLearningPanel は、公開した SOP の同じ digest と
scope に対して未実証/利用観測/worker 報告/独立検証済みを表示する。
試行数、成功検証数/検証数、未完了、人手介入と不明数を併記する。
取得・配信や未確認を成功として扱わない。

## AI-DLC の失敗と保守

canonical gate receipt が段階状態の正本。補助状態は receipt から再構築でき、
失敗した段階・試行・未解決事項・証拠 ref を次の計画と worker に渡す。
blocking な契約検査が失敗した場合、宣言された入力が同じままの再 dispatch
は拒否する。warn-only gate は勝手に blocking に変えない。修正後は再評価する。

curator の archive は生成 origin だけでは許可しない。`background-review manage`
で明示 opt-in した候補だけを対象にし、pin、approval、pipeline/schedule の参照
を保護する。参照 scan が不完全なら archive しない。

```bash
pnpm background-review status --json
pnpm background-review manage --candidate <id> --actor-id <operator>
pnpm background-review request-rollback --candidate <id> --expected-sha256 <適用後digest>
# 返された別の rollback approval を人間が決定してから
pnpm background-review rollback --candidate <id> --expected-sha256 <適用後digest> \
  --approved-by <承認者> --approval-ref <rollback-approval-id>
```

rollback は forward approval を再利用できない。backup の内容・対象・digest
を照合し、現在の内容が適用後 digest と一致する場合だけ復元する。後の人手
編集は上書きしない。復元前の内容も backup に保存し、候補を archive する。
Git 管理下の変更は通常のコード review/PR として確認する。
