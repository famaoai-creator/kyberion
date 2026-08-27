---
title: 組織運営モデルと可視化スコープ設計
tags: [chronos, organization, work-items, operations, governance, visualization]
last_updated: 2026-08-04
status: archived
---

# 組織運営モデルと可視化スコープ設計

## 目的

組織の目的・定常運用・ソリューションプロジェクト・ミッション・実行中の作業を、同じ WorkItem を正規データとして、用途ごとに混ぜずに見せる。

## ビューの責務

| ビュー       | 見えるもの                                           | 主な判断                 | WorkItem 投影           |
| ------------ | ---------------------------------------------------- | ------------------------ | ----------------------- |
| Organization | 組織目的、サービス、定常運用、プロジェクト、意思決定 | 何を維持・変えるか       | `organization` / 全状態 |
| Home         | 人が今日確認する作業と次の行動                       | 次に何をするか           | `home` / active         |
| Work Items   | 実行可能な作業の正規看板と履歴                       | 誰が、どの状態で進めるか | `work_items` / all      |
| Operations   | エージェント、試行、リース、ブロッカー、圧力         | どこに介入するか         | `operations` / active   |
| Missions     | 目標、フェーズ、成果、ミッション配下の作業           | 目標に対して進んでいるか | `missions` / all        |
| Governance   | 承認、レビュー、例外、統制作業                       | 実行してよいか           | `governance` / all      |

ビューは互いに同じ内容を重複表示するのではなく、同じ WorkItem の異なる投影としてリンクする。たとえば Operations のブロッカーから Work Items の該当カード、そこから Mission の目標へ遷移できる。

## 正規コンテキスト

WorkItem の `context` を identity とし、`labels` は検索・分類の facet に限定する。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
                                      └── work_shape
```

包含順の正本は [`entity-scope-hierarchy.md`](../../../../knowledge/product/architecture/entity-scope-hierarchy.md) である。この文書での `organization_id` 先頭表記は WorkItem のフィールド列挙順であり、包含順を表さない。

`work_shape` は `solution_project`、`service_operation`、`routine_operation`、`incident_response`、`governance_cadence`、`improvement_experiment` のいずれかで、組織運営とソリューション開発を区別する。

既存データは `context` がなくても、`metadata`・`project_id`・`mission:` label から一時的に解決する。ただし API はその解決元と警告を `quality` として返し、新規データは作成時に typed context を保存する。これにより、表示を止めずに移行残を追跡できる。

## 実装済みの共有契約

- `libs/core/work-visibility.ts` が全ビュー共通の context 解決と投影を担当する。
- Work Items API は `scope`、`view`、`tenant`、`organization_id`、`mission_id`、`project_id` を受け取る。
- Agent Activity / Chronos Office は `operations/active` 投影を利用し、mission label の有無だけでは除外しない。
- Work Items 画面は scope、view、explicit/migrated/missing context の状態を表示する。
- Home は人の active な作業要約、Operations はエージェント実行状態、Missions/Governance はそれぞれの意思決定面を表示する。

## 次の移行段階

1. 既存の `metadata.mission_id` と `mission:` label を typed `context` にバックフィルする。
2. 作成系 CLI と外部同期の入力契約に `context` を追加する。
3. `quality.migrated_context` が 0 になった時点で legacy fallback の警告を削除する。
4. 重複した TASK_BOARD 状態を WorkItem projection に統合し、ビュー固有の状態コピーを作らない。
