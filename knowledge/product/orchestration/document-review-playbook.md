---
title: '文書理解・設計レビューの実行と証跡'
tags: [review, document, design, comprehension, evidence, isolation]
last_updated: 2026-11-09
runtime_stages: [planning, execution, review]
role_affinity: [ecosystem_architect, reviewer, planner]
---

# 文書理解・設計レビュー

仕様の著者が持つ会話上の前提を、次の実装者や読者が持つとは限らない。
このレビューは明示した文書・参照ファイルの snapshot を新しい隔離コンテキストへ渡し、
提案と現行システムを説明し直させる。説明のずれと未定義の動作を指摘として扱う。
EGM の理解度テストと reviewer 証跡の考え方を、Kyberion の既存隔離・権限境界に適用した。

## 実行

通常は comprehension 一件を実行する。リンク先を自動探索せず、必要な参照を明示する。

```bash
pnpm pipeline --input pipelines/document-review.json --context '{"target":"docs/GLOSSARY.md","references":[],"preset":"comprehension"}'
```

設計レビューは source を明示する。入力のない drift 検査を成功扱いにしないため、sources は必須。

```bash
pnpm pipeline --input pipelines/document-review.json --context '{"target":"knowledge/product/architecture/example.md","references":[],"sources":["libs/core/example.ts"],"preset":"design"}'
```

example のパスは対象に置き換える。design は comprehension → readiness → drift → code_contract を
直列実行する。前段の reviewer の回答は後段へ渡さない。code_contract は source ごとに
interface / invariants / side_effects と根拠を返す。根拠のない性質は空配列とする。
readiness と drift は指摘ゼロの場合も、根拠引用を持つチェックリストを必須とする。
readiness は対象ファイル、決定済み API、エラー処理、段階ごとの検証、未決の設計選択を点検する。
drift は未実装、古い文書、文書に記録された変更、証拠不足を区別し、計画を実装済みの約束と混同しない。

generator は既定 claude。codex は既存 isolated generator の tested-version gate に従う。
未検証バージョンの強制許可や通常 backend へのフォールバックはこの op からは指定できない。
必要な認証、egress 許可、provider custody 条件を事前に満たす。

## 上限と境界

- 一ファイル64 KiB、総入力128 KiB。references / sources はそれぞれ最大16件。
- timeout_ms は1000〜120000 ms、core API の既定60000 ms、例示 pipeline の既定120000 ms。
  全 reviewer を通じた一つの期限であり、並列数や試行回数を増やさない。
  例示 pipeline は静的 schema 検証のため120000 ms固定。変更する場合は wisdom:document_review op を直接使う。
- UTF-8 text のみ。空、binary、symlink、checkout 外、読み取り拒否は provider 呼び出し前に止める。
- 未分類の scratch / staging / legacy mission は public と推定しない。明示した tier/tenant partition に配置してから実行する。パス分類器の保護 tier は大文字小文字によって下げない。
- 読み取りは secure-io。入力の正規パスから tier / tenant を導き、既存 runtime scope を狭める。
  private 入力には対応する payload scope が必要。別 tenant の資料を一つのレビューへ混ぜない。
- 出力は派生情報なので入力以上の保護を維持する。op の params には tier や waiver を受け付けない。
- 各 reviewer は tools-off isolated generator を使う。文書内の命令にファイル操作や承認の権限はない。

## レポートと保存

結果は pipeline context の document_review に返る。status は completed / incomplete、
verdict は reviewed / changes_requested / incomplete。reviewed は人間の設計承認を意味しない。
既存の mission / task の検証・承認手順を続ける。

保存は owner が writeScopedArtifact を使用する。report.effective_tier と tenant_slug を下回る
場所へ書かず、mission / task / organization の既存 scope に結びつける。surface へ届ける場合は
同 API の publish を使う。無条件の public artifact や任意パスへの書き出しは pipeline に持たせない。

各 receipt は、実際に読み取って入力した内容の hash、ファイル一覧、input hash、隔離方式を記録する。
report.review_sha256 は全入力 snapshot と reviewer 構成・prompt の manifest hash。
round.artifact_sha256 にはこの review_sha256 を使い、対象文書の hash だけを渡さない。
evidence_kind は host_snapshot_injected。reviewer が Read tool を呼んだという意味ではない。
native_read_evidence は not_applicable、isolation_probe は not_run。ここで live probe の成功は主張しない。
引用は入力の path / hash / 文字列と照合する。空出力、不正形式、存在しない引用、timeout、
provider エラーは not_run とし、指摘ゼロや clean に数えない。完了済みの他 reviewer の結果は保持する。
親会話を渡さないこと、host instruction の隔離、actor の独立性、認証された provenance は
別々の条件であり、同じ boolean へまとめない。

## 指摘の処理と再レビュー

core の evaluateDocumentReviewRounds は最大5 round を純粋に評価し、永続ストアや権限を作らない。
既存 WorkItem / mission evidence で保存した round と resolution を owner が渡す。

- identity は reviewer / semantic_scope / issue_key。行番号や artifact revision は identity に使わない。
- blocking の未解決指摘は次の reviewer が忘れても残る。修正済みの再発は再開する。修正済み扱いにも、変更後の manifest と根拠を照合する信頼された検証が必要。
- contested / accepted_risk の記録だけでは解消しない。owner の既存 evidence / approval 検証 callback が
  現在の artifact、対象 scope、根拠を照合する。accepted_risk は一致する authority_ref も必要。
  モデル出力から callback や authority_ref を作らない。
- clean 判定はその round の修正を適用する前に行う。要求した reviewer が欠ける round は clean にならない。
- 同じ artifact hash に対する2回連続の clean で converged。artifact が変われば連続回数をリセットする。
- 5 round 上限または明示した修正の取り消しを要する churn は needs_decision。自動受容せず owner に戻す。

op は一度に一 round を返す。自動の修正ループ、リスク受容、重大指摘の waiver は実行しない。

## 開発時の検証

```bash
pnpm exec vitest run libs/core/workforce/document-review.test.ts libs/core/workforce/document-review-rounds.test.ts libs/actuators/wisdom-actuator/src/document-review.test.ts
pnpm --filter @agent/core run build
```

これらは hermetic fixture の境界検証。実モデルの理解力・品質改善率・host ごとの live isolation を
証明しない。live 評価は対象 commit、provider / client version、入力 hash、失敗件数、費用を別途記録する。

参照: [EGM](https://github.com/google/elephant-goldfish-model/tree/e9e1f06aa4e26e95cd4ed37210a0632202c429e9)
（Apache-2.0）。本実装は EGM plugin をインストールせず、既存 Kyberion 境界に接続する。

## daemon からの隔離呼び出し

Codex isolated transport は spawn 境界でも SYSTEM_ROLE を明示的に除去する。
barrel 経由で daemon から到達可能になっても、provider 子プロセスへ daemon 権限を継承しない。
この境界は codex-isolated-query.test.ts と role-assumption-reachability gate で検査する。
