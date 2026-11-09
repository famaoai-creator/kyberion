---
title: 記憶のループを閉じる計画（スコープ付きの候補と 1 本の取り込み経路）
kind: plan
status: planned
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

## 完了の合図

concept-registry から `memory-candidate` の `lifecycle` を外します。ループの健全性の指標が、継続して 0 ではない値を示すことを確認します。
