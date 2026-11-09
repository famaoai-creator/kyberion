---
title: WorkItem（Issue と子ステップ）と Lease の統合計画
kind: plan
status: completed
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

実装の記録（W3）：

- 資源の種類：`LEASE_RESOURCE_KINDS`（`lease-backend.ts`）と、`FencedLeaseRecord` の任意フィールド `resource_kind`。W3 より前の記録（writer-lease の journal など）は `resource_kind` を持たないまま読めます。スキーマ `writer-lease.schema.json` も任意フィールドとして受け付けます（`acquired_at_ms` / `renewed_at_ms` / `attributes` も同様）。
- 決める場所は 1 つ：保持者・期限・世代（`fence`）・有効かどうかは `libs/core/lease/lease-terms.ts`（`grantLeaseTerms` / `renewLeaseTerms` / `releaseLeaseTerms` / `isLeaseLive`）だけが決めます。生きている世代がある間の取得は、同じ保持者でも `LEASE_HELD` です。再入（リプレイ、同じ保持者の更新）はアダプターが選びます。期限切れの lease は更新できません。
- 解放のあとで取得して返す lease：`resource-lease.ts` が lease-backend の上で取得・更新・解放を行います。記録の読み書きはすべて資源ごとの backend lock の中です。W3 より前のファイルは `readLegacy` で 1 リリースの間だけ二重に読みます。
- 監査：`lease-audit.ts` の `recordLeaseAuditEvent` が、どの種類の lease も `action: lease.acquire|renew|release|expire`、`operation: <kind>:<resource_id>`、同じ metadata（`resource_kind`、`resource_id`、`holder`、`fence`、`expires_at`、`lease_id`）で監査チェーンに書きます。監査に失敗しても lease の結果は変わりません（warn を出すだけ）。
- アダプター（指示の順）：

  | lease                          | 変換後                                                                                                                                                                                                                                                                                                   | 記録                                                                                                |
  | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
  | WorkItem の claim              | `work-item-lease.ts`（`work_item`）。claim・更新・解放・期限切れ・pipeline の再開が terms を使い、`fence` は項目の lease の最大値の次。`activeLeaseForItem` は `isWorkLeaseLive`（active かつ期限前）で、W2 の「claim 中の親は触らない」もこれを見ます。排他はこれまでどおり coordination store の mutex | leases.jsonl のまま。`fence` を任意で追加。W3 より前の lease は世代 0                               |
  | Co-Session のパス lease        | `path`。排他は lease-backend の lock（同じ名前空間）。同じ保持者の再取得は更新で、`lease_id` と `fence` を保ちます                                                                                                                                                                                       | `leases/{path_hash}.json` のまま。`fence` を任意で追加                                              |
  | video / audio のデバイス lease | `device`（`device-lease.ts` を共有し、両 manager は資源名と保存先だけを渡す）。heartbeat は毎回持ち主かを確かめ、更新は TTL の 1/3 ごと。止まっていた lease は、ほかの誰も取っていなければ次の世代を取り直します                                                                                         | 同じパスの fence 付き記録。解放後も残して世代を保つ。旧形式で生きているファイルは期限まで取得を拒む |
  | Mission Lease                  | `mission`。取得・更新・解放の期限計算を terms に寄せ、durable 記録に `resource_kind: mission`                                                                                                                                                                                                            | 変更なし                                                                                            |
  | dot の仲裁                     | 独自の lease を持っていません（WorkItem の claim 状態を読むだけ）。そのため `work_item` アダプターに乗ります。`dot_slot` は種類として予約し、今は使っていません                                                                                                                                          | なし                                                                                                |

- 境界テスト：`tests/lease-bookkeeping-boundary.test.ts`。`libs/core/lease/` の外で lease 型を扱うファイルについて、期限の計算（時計からの算出、解放の印 `0`）、`holder_*` / `owner_id` の自前の代入、手での `fence` の加算を落とします。W3 より前のコードでは 17 か所が検出されることを確かめています。対象外は `browser-extension-bridge.ts`（拡張機能のペアリングの有効期間で、D2 の資源 lease ではない）だけで、理由つきで列挙しています。
- 振る舞いの変化：audio のデバイス lease も、ほかのセッションに取られたら heartbeat が失敗します（以前は気づかず上書きしていました）。期限が読めない WorkItem の lease は「有効でも期限切れでもない」状態ではなく、期限切れとして扱います。デバイスの解放はファイルを消さず、`expires_at_ms: 0` の記録を残します。
- 残り：WorkItem と Co-Session の記録は、これまでのストア（leases.jsonl、`leases/*.json`）に置いたままです（保持者・期限・世代は terms から写すだけ）。ブラウザ拡張機能の lease は D2 の一覧の外です。WorkItem の lease を読む側（dot の結果の証拠検査など）は `expires_at` を自分で読んでいますが、書き込みはしません。

## 完了の合図

concept-registry から `work-item` と `lease` の `lifecycle` を外します。W3 で外しました（`scripts/check_concept_registry.ts` は通っています）。
