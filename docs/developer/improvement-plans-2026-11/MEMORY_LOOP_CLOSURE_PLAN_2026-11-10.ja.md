---
title: 記憶のループを閉じる計画（スコープ付きの候補と 1 本の取り込み経路）
kind: plan
status: active
last_updated: 2026-11-10
tags: [plan, concepts, memory, distill, promotion, knowledge-index, context-pack, disclosure]
importance: 9
---

# 記憶のループを閉じる計画

決定記録 [Concept Model v2](../../../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md) の D8 を実装する計画です。4 本の移行計画の 4 本目です。開示範囲の判定は [スコープ・ID・権限の統合](./SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md) の Grant に乗ります。M1 はそれを待たずに始められます。

目標は 2 つです：**改善のループが実際に回ること**と、**開示の範囲が制御できること**。

## 現状（2026-11-10 の調査）

- 学びを捕まえる場所が 9 つ、候補の形式が 3 種類（`MemoryCandidate`、`DistillCandidateRecord`、`OrganizationLearningCandidate`）、キューが 4 つあります。
- 昇格した記録（`knowledge/product/evolution/*/generated/`、`wisdom/generated` だけで 236 件）は、テナントに属さない mission のコンテキストパックに関連性で取り込まれません。
  - `libs/core/knowledge/distill-knowledge-injector.ts` が見るのは、最上位の `distill_*.md` だけです。
  - その `distill_*` の約 70 件は、`knowledge-slices.json` でコーパスから除外されています。
  - つまり、取り込みの経路は実質的に止まっています（コードからの推定で、実行しての確認は M1 の最初に行います）。
- 昇格キュー（`active/shared/runtime/memory/promotion-queue.jsonl`）には 1 行しかありません。
- 「distill」「wisdom」「hint」「memory」「promotion」がそれぞれ複数の意味で使われています。

## 段階

### M1 — ループを閉じる（最優先）

- まず、昇格した記録が次の mission のコンテキストパックに入らないことを、再現テストで確かめる。
- コンテキストパックの取り込みを、ナレッジインデックス（`evolution/**/generated` を含む）からの関連性検索に一本化する。読み手の Grant のスコープ（tier とテナント）で絞り込む。
- `distill-knowledge-injector.ts` と `distill_*` のコーパスを retire する。必要なものだけ選別して移す。
- ループの健全性を測る指標を出す：昇格した件数 → 取り込まれた件数 → 使われた件数（タスクの結果で参照されたもの）。3 段のどれかが 0 のまま続いたら、gate または警告で知らせる。
- 完了条件：昇格した記録が、関連する次の作業のコンテキストパックに入ることを e2e テストで確かめる。指標が報告に出る。

### M2 — 候補を 1 つの型にする（スコープは捕まえた時点で決める）

- `MemoryCandidate` を唯一の候補の型にし、`kind`（lesson、heuristic、process_improvement、hint、…）と `lane` を持たせる。
- **必須項目**：`tier` と entity scope（tenant → org → project → mission）。捕まえた時点で書き、昇格・取り込みのときに推測しない。
- `DistillCandidateRecord` は昇格の受領記録だけにする。組織の学習候補、プロセス改善の提案、実行時のフィードバック、heuristics、trace hint は、このキューに流す。
- 完了条件：キューは 1 つ。スコープのない候補は登録の時点で拒否する（テストで固定）。

### M3 — 用語を分ける（M2 と同時）

- distill：mission から候補を作ること。promote：候補を知識にすること。wisdom：actuator の名前だけ。
- hint は 1 つのランタイムのストアと、そこから生成する `HINTS.md` のビューにまとめる。
- GLOSSARY と registry を合わせ、`memory-candidate` の `lifecycle` を外す。

## 進捗（2026-11-10）

- **M1**：完了。昇格した記録は `findRelevantPromotedKnowledge` でコンテキストパックに入ります。
- **M2（済）**：`MemoryCandidate` に `kind` と `lane` を足し、捕まえた時点で書きます。古い行は読み込み時に補います（スコープは補いません）。confidential と personal の候補は、スコープがないと登録の時点で `MEMORY_SCOPE_REQUIRED` で拒否します（`memory-candidate-capture-scope.test.ts`）。案件の結果、background review、mission の heuristics、レビューで差し戻された学び、知識の不足、curation の助言は、スコープを付けて登録します。`distill-knowledge-injector.ts` は削除し、残っていた 3 か所の呼び出しは promoted の経路に移しました。
- **M2（2 回目、済）**：組織の学習候補とプロセス改善の提案は、`MemoryCandidate` のキューの行になりました（`kind` は `organization_learning` / `process_improvement`、`origin` に元の facade の項目を持ちます）。`pnpm organization learning enqueue|transition` と `pnpm mission improvements --approve|--reject|--apply` は、キューの行を作り、決めます。汎用の昇格（`promoteMemoryCandidateToKnowledge`、`memory-promote-pending`、Concierge の一括昇格）は、`origin` のある行を昇格しません（`MEMORY_PROMOTION_OWNED`）。昇格の経路は学び 1 つにつき 1 本です。古いストア（組織ごとの `learning/<id>/candidate.json` と共有の `coordination/process-improvements/queue.jsonl`）は読むだけにしました。1 リリースの間だけ、`pnpm organization learning migrate` と `pnpm mission improvements --migrate [--write]` が、保留中の項目を記録自身のスコープ（組織の tier・tenant、または mission の状態の tier・tenant）で取り込みます。スコープが決まらない項目（personal の組織の学び、mission の状態がない提案）は `unresolved` に出し、推測しません。適用した作業指示は、共有の場所ではなく、提案の tier・tenant の artifact floor に書きます。
- **M2（2 回目、一部）**：`wisdom:distill` は `DistillCandidateRecord` を読まず、キューの public の行だけから要約を作ります（tenant の学びを共有の要約に混ぜません）。要約の推薦も public で登録します。
- **M2（残り）**：background review の skill patch / pipeline 提案と、実行時のフィードバックの提案は、まだ `DistillCandidateRecord` に書いています（`background-review-patch.ts` と `execution-feedback*.ts` の承認・適用の流れがこの記録の上にあり、移すには両方の流れを書き直す必要があります）。なお、background review の記憶の提案は、すでにキューに書いています。
- **M3（済）**：mission distill の識別子とログを用語に合わせました（`loadDistillPolicy` など。古い名前は 1 リリースの間、非推奨の別名として残します）。GLOSSARY の「Promotion (Memory)」「Memory Candidate」を直しました。
- **M3（2 回目、済）**：`wisdom-policy.json` を `distill-policy.json` に、schema を `distill-policy.schema.json` に改名しました（新しいファイルがなければ、古いパスを 1 リリースの間、警告付きで読みます）。`KYBERION_WISDOM_LLM_PROFILE` は `KYBERION_DISTILL_LLM_PROFILE` に改名し、古い名前は 1 リリースの間、非推奨の警告付きで受け付けます（env-registry と生成された設定の文書を更新）。volatile の sidecar の `status: promoted`（推薦しただけの意味）は `nominated` にし、古い値は読み込み時に `nominated` として扱います。hint は下の設計どおり 1 つのストアと生成するビューにしました。
- **完了の合図（未達）**：`DistillCandidateRecord` を受領記録だけにする作業が残っているため、`memory-candidate` の `lifecycle`（`transitioning`）はまだ外しません。ループの健全性の指標が 0 でないことは、今のところテストの fixture でしか示せません（実際の運用での数値ではありません）。

### M3 の hint の設計（実装前に決めたこと）

- **ストアは 1 つの API と 1 つの schema で、スコープごとに分けて置きます。** `libs/core/knowledge/hint-store.ts` が唯一の読み書きの入口です。置き場所は登録済みのランタイムの root `active/shared/runtime/hints/<tier>/<tenant|shared>/<category>.json` です（storage-layout の `<tier>/<tenant|shared>/`）。public は `public/shared/`、tenant の hint は `confidential/<tenant>/` に置き、共有の場所には書きません。personal の hint は受け付けません（owner ごとの記憶は personal の候補キューに置きます）。
- **スコープは書いた時点で決めます。** 呼び出し側がスコープを渡します（mission の hint は mission の tier と tenant）。渡さない場合は、実行中の credential binding の tenant、なければ public です。推測で tenant を補うことはしません。
- **`HINTS.md` は生成するビューです。** 昇格した hint は、まずストアの `promoted` カテゴリにスコープ付きで書きます。そのあと、そのスコープの `HINTS.md` を新しい 50 件から作り直します。製品の `knowledge/product/governance/HINTS.md` は public の hint だけから、tenant の `knowledge/confidential/<tenant>/evolution/HINTS.md` はその tenant の hint だけから作ります。personal や tenant のない confidential の hint は、製品のビューに出しません（これまでは出ていました）。ビューから外れた節は、これまでどおり archive に移します。
- **古いストアは 1 リリースの間、読むだけにします。** `active/shared/runtime/feedback-loop/hints/` には、もう書きません。スコープを渡さない読み手（ADF の修復など）と、ナレッジインデックスの製品の読み込みだけが、1 リリースの間ここも読みます。既存の `HINTS.md` の節は、最初の生成のときにそのスコープのストアに取り込みます（置き場所でスコープが決まっているので、推測ではありません）。
- **worker の指示に入れる差し戻しの学びは、その mission のスコープの hint だけにします。** これまでは、ほかの tenant の差し戻しも入っていました。

## 完了の合図

concept-registry から `memory-candidate` の `lifecycle` を外します。ループの健全性の指標が、継続して 0 ではない値を示すことを確認します。
