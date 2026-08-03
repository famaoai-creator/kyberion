---
title: Project Management Control Plan 2026-08-03
tags: [project, mission, track, task-session, control-plane, reconciliation, cli]
last_updated: 2026-08-03
status: implemented-review-pending
---

# Project 管理統制計画

## 背景

Project Record、Project Operational State、Track、Mission、Task Session は既に存在するが、利用者が一つの管理経路として扱える統合 facade が不足している。現状では Project の参照は Registry / Presence / Chronos / Voice Hub に分散し、Mission の Project 再所属、旧 Project の台帳・state の掃除、Surface 非依存の Bootstrap が governed operation として閉じていない。

## 目的

Project を長期的な意味・運用のコンテナとして管理でき、Project → Track → Mission → Task/Task Session の関係を安全に可視化・更新できる状態にする。

## 改善項目

| ID    | 改善                         | 完了条件                                                                                                             |
| ----- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PM-01 | Project 管理 facade / CLI    | list、show、create、update-status、archive、reconcile を secure-io と schema 検証経由で実行できる                    |
| PM-02 | Mission の Project 再所属    | paused 等の安全な状態で、Mission relationship、旧/新 Project ledger、operational state、監査記録を一貫更新できる     |
| PM-03 | Project state reconciliation | Registry、Mission、Track、Task Session の現在値から dry-run / apply の不整合検出・修復ができる                       |
| PM-04 | Surface 非依存 Bootstrap     | CLI / Core API が Project Record、Project OS、kickoff Task Session、Mission Seed を同じ契約で作成できる              |
| PM-05 | Operator UX の階層表示       | Project、Track、Mission、Task、Task Session、Pipeline の役割と lineage を Control Plane の読み取りモデルで表示できる |

## 設計方針

- Project Registry は識別・目的・サービス結合の正本、`active/projects/<tier>/<tenant_or_shared>/<project_id>/state/` は現在の運用投影とする。
- 更新は `@agent/core` の typed facade を通し、Surface や CLI が JSON を直接編集しない。
- Mission 再所属は移動元を消さず、旧 ledger の行を除去し、新 ledger と新 operational link を作成し、監査イベントを残す。
- `task` は Mission の作業単位、`task_session` は会話作業コンテナとして表示上も分離する。
- Pipeline は状態の親ではなく、再現可能な実行手順として lineage に表示する。
- Project の tier / tenant / path 境界は fail-closed で検証する。
- 組織全体の Purpose、Service、定常 Operation、Incident、Governance との関係は
  [Organization Operating Model Plan](./ORGANIZATION_OPERATING_MODEL_PLAN_2026-08-03.ja.md)
  で扱い、Project は `solution_project` の管理単位として接続する。

## 実装フェーズ

1. Core の Project 管理 facade、reconciliation report、Project Bootstrap contract を追加する。
2. Mission Controller に Project 再所属コマンドと ledger/state 同期を追加する。
3. Project CLI と既存 Control Plane API の read/write boundary を接続する。
4. Chronos / Presence の Project hierarchy projection と role explanation を追加する。
5. schema、contract、integration、build、baseline、governed pipeline を検証する。

## 受入検証

```bash
pnpm project list --json
pnpm project reconcile --dry-run --json
pnpm mission reassign-project <MISSION_ID> --project-id <PROJECT_ID> --project-path <PATH> --dry-run
pnpm pipeline --input pipelines/project-management-validation.json
pnpm exec vitest run libs/core/project-management.test.ts libs/core/mission-project-reassignment.test.ts
pnpm run typecheck
pnpm run build
```

## 実装状況

- 2026-08-03: 計画作成。Mission `MSN-PROJECT-CONTROL-20260803` で実装を開始。
- 2026-08-03: Core facade、Project CLI、Project OS scaffold、Mission 再所属、ledger/state reconciliation、Task/Task Session/Pipeline lineage、Presence/Chronos read model、validation pipeline を実装。
- 2026-08-03: 対象テスト・build・typecheck・contract checks は通過。全体 `validate` は既存 Chronos contrast 違反6件で停止したため、修正対象外としてレビューへ引き渡し。
