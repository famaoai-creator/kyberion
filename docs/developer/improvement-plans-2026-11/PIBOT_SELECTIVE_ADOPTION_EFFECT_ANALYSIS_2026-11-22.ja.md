---
title: 'PiBot 選択的採択 — 効果分析 (PB-01〜06)'
kind: analysis
status: active
last_updated: 2026-11-22
tags: [analysis, pibot, adoption, approval, policy, workflow, ux]
---

# PiBot 選択的採択 — 効果分析 (2026-11-22)

実装ブランチ: `fix/scoped-mission-approval-pibot-20261122`（[PR #1563](https://github.com/famaoai-creator/kyberion/pull/1563) を `origin/main` に rebase したうえで PB-00〜06 を載せる）。
base: `origin/main` @ 同期時点の tip + #1563 commits。

## PR #1563 との整合

| #1563 仕組み | PiBot 採択側の扱い |
| --- | --- |
| 同一 approval を terminal と Concierge で共有 | PB-01 `primaryAction` も同じ `decideApprovalRequest` / Owner ゲート経由 |
| `APPROVAL_TENANT_OWNER_REQUIRED` (HTTP 403) | Concierge approvals + passkey ルートに `conciergeTenantOwnerApprovalDenied` |
| Owner 決定後 CLI が Grant を resume | Always は無効（`grant_resume_not_session_always`）。Allow once = Owner 決定 |
| same-tenant `credential.use` の requiredRoles=`owner` | `requestGrantApproval` に取り込み済み |

## 要約

| ID | 実装面 | 効果 | 残ギャップ |
| --- | --- | --- | --- |
| PB-00 | 分析・吸収モデル・registry | 概念語彙がゲート可能 | — |
| PB-01 | Needs You 一次アクション + Why + API `primaryAction` | Concierge が Deny / Allow once / Always に収束。Always は session cache（効果束縛必須）。send_out 等は Always 無効 | チャット表面の 4 ボタン語彙との完全一致、standing Grant 本線は grant 承認チャネル依存 |
| PB-02 | `interactionPacket` + `resolvePlanInteractionAction` | Start → `approvePlanAndStart` 契約にマップ | Needs You 自動 enqueue / UI ボタン配線は薄い |
| PB-03 | disposition + `work_item_id` on failures | failure → WorkItem disposition API | 通知側が `work_item_id` を載せる発行元の網羅 |
| PB-04 | `evaluatePolicyCategory` + expected.tsv | 代表セル固定。Always 禁止 ↔ PB-01 / #1563 | actuator manifest 全量 + preflight listener は段階 |
| PB-05 | Changes/Tasks + intelligence `collectMissionProgress` | `/ops` に artifacts + child WorkItems | uncommitted diff の VCS 供給は未接続 |
| PB-06 | `appendVerdictRepair` ≤ 2 | 3 回目 `replan_limit` | dispatch 自動呼び出しは未接続 |

## 非回帰（守ったもの）

- approval-store settle は二値のまま（Always = approved + sessionCache）
- Surface は正本にならない（presented digest / primaryAction はサーバーで再検証）
- CEO 面は件数のまま；詳細は Concierge `/ops` / `/inbox`
- 群チャット / YOLO / Pi ランタイムは持ち込まない

## 計測（この変更で追加したテスト）

- `libs/core/governance/policy-category.test.ts`
- `libs/core/governance/policy-category-matrix.test.ts`（`tests/fixtures/policy-category-matrix/expected.tsv`）
- `libs/core/surface/approval-primary-actions.test.ts`
- `libs/core/surface/plan-interaction-packet.test.ts`
- `libs/core/surface/mission-changes-tasks-summary.test.ts`
- `libs/core/workforce/workflow-disposition.test.ts`
- `libs/core/mission/mission-verdict-repair.test.ts`
- Needs You アクション期待値更新（approval / failure）

## 推奨フォロー

1. failure 通知に `work_item_id` を載せ、disposition API を確実に結線する
2. plan packet Start を既存 `approvePlanAndStart` に e2e で載せる
3. 代表 actuator manifest に `policy_category` を宣言し preflight listener を登録する
4. intelligence observation が uncommitted diff / child tree を `withMissionChangesTasks` に渡す
