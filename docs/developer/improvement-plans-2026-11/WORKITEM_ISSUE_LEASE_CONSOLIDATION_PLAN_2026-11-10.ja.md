---
title: WorkItem（Issue と子ステップ）と Lease の統合計画
kind: plan
status: planned
last_updated: 2026-11-10
tags: [plan, concepts, workitem, lease, coordination, kanban]
importance: 8
---

# WorkItem（Issue と子ステップ）と Lease の統合計画

決定記録 [Concept Model v2](../../../knowledge/product/architecture/decisions/2026-11-10-concept-model-v2.md) の D1〜D2 を実装する計画です。4 本の移行計画の 2 本目で、[スコープ・ID・権限の統合](./SCOPE_IDENTITY_GRANT_CONSOLIDATION_PLAN_2026-11-10.ja.md) の S1 のあとに始めます。

## 結論

| 決定        | 今                                                                                                                                                            | 移行後                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 WorkItem | Issue（追跡）とロック（排他）を 1 つのレコードが兼ねる。mission に 1 件、タスクごとに 1 件、dot のアクションごとに 1 件と粒度が揃わず、親子のフィールドがない | 上位の WorkItem が Issue。Mission / Task Session / Pipeline / dot は、その Issue を実行する手段。ステップは `parent_item_id` を持つ子の WorkItem になり、lease は子で取る |
| D2 Lease    | mission-lease（`libs/core/lease/` を利用）、WorkItem、Co-Session、dot の仲裁、video と audio のデバイスがそれぞれ独自の期限と保持者の管理を持つ               | `libs/core/lease/`（`LeaseBackend`、fence 付きの記録）だけが期限と保持者を管理する。他はすべて資源名を渡す薄いアダプター                                                  |

## 段階

### W1 — 親子の導入（追加だけ）

- `WorkItem` に `parent_item_id?` を足す（`work-coordination-types.ts`）。上位の WorkItem は `parent_item_id` を持たない。
- `recordMissionHandoff` と mission のタスクの dispatch で、タスクの WorkItem に mission の所有アイテム（`deriveMissionOwnershipItemId`）を親として設定する。
- dot（`dot-dispatch.ts`）と discussion（`discussion-outcomes.ts`）が作る WorkItem に、親がある場合は設定する。
- 完了条件：新規に作られるステップの WorkItem は全件が親を持つ。既存のアイテムには、`context.mission_id` / `task_id` から親を埋める移行（`migrateLegacyWorkItemContexts` を拡張）。

実装の記録（W1）：

- 型と検証：`parent_item_id` は `work-item-hierarchy.ts` で検証します。親が存在すること、自分自身を親にしないこと、循環しないこと（`MAX_WORK_ITEM_DEPTH` 段まで）、親と子のテナントが同じこと（組織は両方にあるときだけ一致を求める）。親のリンクは作成の同一性（`createWorkItemIfAbsent` の再実行判定）には含めません。
- mission のタスク：`mission-ownership-item.ts` が所有アイテムを作り（最初のタスクのテナントで）、`mission-orchestration-progress.ts`、`mission-orchestration-worker-part-core.ts`、`mission-orchestration-worker-part-dispatch.ts`（goal-driven）、`mission-ticket-dispatch.ts` が親を設定します。所有アイテムが別のテナントにあるときは親を付けずに警告します。`recordMissionHandoff` は既存のアイテムを更新するだけで、作成はしません。
- dot：`target: work_item:<id>` で既存のアイテムに作用するアクションだけが、そのアイテムの子になります（同じテナントのとき）。それ以外（path / service / pr / org_operation / mission の受け入れ / target なし）には自然な親がないので上位のままです。
- discussion の結論は Issue なので上位のままです。
- 既存のアイテム：`pnpm work migrate-parents`（既定は dry run、`--apply` で書き込み、何度実行しても同じ結果）。
- 一覧：`listWorkItems` の `topLevelOnly` / `parentItemId`。親の状態の集約は純関数 `aggregateParentStatus` だけを用意し、ボードへの接続は W2 で行います。

### W2 — ボードの既定表示と状態の集約

- board（kanban）の既定表示を上位の WorkItem にする。子は展開して見る。
- 親の状態は子から集約する（すべて done なら親を review にする、など）。規則は 1 か所に置く。
- Concierge / Chronos のビューで、Issue の単位で読めることを確認する。

実装の記録（W2）：

- 集約の規則：子の状態から作る値は `aggregateParentStatus`、それを親に反映するかどうかは `resolveParentStatusSync`（どちらも `work-item-hierarchy.ts`）の 1 か所だけです。上から順に最初に当たった行で決まります。

  | 親の状態                                                      | 結果                                                                             |
  | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | 子がない                                                      | そのまま                                                                         |
  | done / archived                                               | そのまま（Issue を閉じるのは人）                                                 |
  | claim 中（有効な lease、または保持中の effect）               | そのまま（保持者が状態を持つ）                                                   |
  | 子があるときに人が状態を直接変えた（`status_origin: manual`） | そのまま。`statusFromChildren`（CLI は `--status-from-children`）で集約に戻す    |
  | 集約値と同じ                                                  | 書き込まない（何度実行しても同じ）                                               |
  | 集約値が archived（子がすべて取り下げ）                       | そのまま（取り下げで Issue は閉じない）                                          |
  | 前回も集約で決まった（`status_origin: children`）             | 集約値にする（新しい子が来れば review から in_progress に戻る）                  |
  | 一度も集約していない                                          | 集約値が先へ進むときだけ反映（backlog → ready → in_progress / blocked → review） |

- 接続点：`work-coordination.ts` の項目スナップショットの書き込みはすべて `writeItemSnapshot` を通り、子の状態か親が変わったときに `work-item-parent-status.ts` が親（親を移したときは元の親も）を再集約します。親の書き込みも同じ経路を通るので、祖先まで順に伝わります（`MAX_WORK_ITEM_DEPTH` 段まで）。集約による更新は `item_updated` イベント（`status_origin: children`、ステップ数つき）として残ります。
- ボード：`workspace.list` に `top_level=true`（Issue だけ。親が見えない子はカードとして残す）と `parent_item_id`（1 つの Issue の子）を追加し、Issue にはそのビューアに見える子の数と完了数（`steps`）を付けます。`/work?tab=items`（管制塔の `work-items` も同じ画面に移っています）は検索語がないとき Issue だけを並べ、カードに「ステップ n 件中 m 件が完了」と進捗バー、開くと子の一覧（状態つき）を出します。テキスト検索では子も単独で見つかります。項目の詳細ページでは、子が「含まれるもの」に、親 Issue がパンくずに出ます。mission の所有アイテムは mission の名前とプロジェクトで表示し、内部の説明文は出しません。
- CLI：`pnpm work list-board --board-id <id>` は Issue と `steps` を返し、`--all-items` で子も並べます。`list-items` は `--top-level` / `--parent-id` を受け付けます。
- 機械向けの投影（`/api/ops/workitems`、headless の `work-items`）は全件を返したままです。

### W3 — Lease の一本化

- `libs/core/lease/` に資源の種類を表す `resource_kind` を足す（`work_item`、`mission`、`path`、`device`、`dot_slot`）。
- 次の順にアダプター化し、独自の期限・保持者の管理を削除する：WorkItem の claim → Co-Session のパス lease → video / audio のデバイス lease → dot の仲裁。
- lease のイベント（取得・更新・解放・期限切れ）を 1 つの監査の形にする。
- 完了条件：`lease-backend` 以外に `expires_at` / `holder` を自前で書いている lease 実装が 0 件。

## 完了の合図

concept-registry から `work-item` と `lease` の `lifecycle` を外します。
