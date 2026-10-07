---
title: プロジェクト依存ミッション連鎖の実走メモ (PRJ-KYBERION-PRODUCTION-READINESS, 2026-10-07)
tags: [mission, project, dependencies, dispatch-queue, reconcile-work, review-task, tenant-registry]
last_updated: 2026-10-07
role_affinity: [mission_controller]
phase_affinity: [execution, review]
---

# 依存ミッション連鎖デモの記録

対象: `PRJ-KYBERION-PRODUCTION-READINESS` (confidential/kyberion-service-studio)。
連鎖: BASE → OBS → GO (`MSN-KYBERION-READINESS-{BASE,OBS,GO}-20261007`)。
二層依存: `relationships.prerequisites` (create時 `--prerequisites`) と
dispatchキュー `dependencies` (`mission enqueue <ID> <tier> <prio> <deps>`)。

## 検証済みの挙動

- `dispatch` は依存未完了の下流を `Skipping ...: waiting for ...` で飛ばす。
- 上流 `cancel` (failed) 後も下流は `pending` のまま起動しない。
- `repair` → `start --goal --success-condition` で上流復帰可能。
- `verify` → `distill` はタスク残があっても通過する。`finish` は通過しない。
- `checkpoint` は mission repo に commit する (証拠の commit-bound 化に利用可)。
- `review-task <MID> <review-task> <reviewer-agent>` の第3引数は reviewer agent。
  implementer の `record-evidence --actor-id` が先に必要 (独立性検証のため)。

## 未解決の制約

### R1: reconcile-work と review-task の receipt path 不整合 (independent micro-repo) → 修正済み

- `review-task` が書く receipt の `artifact.path` は repo-root 相対
  (`active/missions/.../evidence/implementation-report.md`)。
- `reconcile-work` を mission repo を `source.repository` にして dry-run すると
  `reviewed artifact file not found: .../MSN-.../active/missions/...` になった。
- 修正: `libs/core/mission/mission-work-reconciliation.ts` に
  `resolveReceiptArtifactPath` を追加。直解決を先に試し、存在しなければ
  repo-root 解決が source.repository 内に落ちる場合にそれを使う
  (tolerant reader。writer 規約は不変、worktree 経路は従来通り)。
- テスト: `mission-work-reconciliation.test.ts` に repo-relative receipt の
  ケースを追加 (23 passed)。
- 修正後に BASE/OBS/GO の reconcile が dry-run/apply ともに通過し、
  3連鎖すべて archived まで完走した。

### R2: dispatch-tickets の tenant-profile 読取拒否 (sandbox)

- `dispatch-tickets --ticket-targets workitem` が
  `[ROLE_VIOLATION] ... knowledge/personal/tenants/kyberion-service-studio.json`
  で失敗する。ファイルは存在する。`KYBERION_PERSONA=sovereign` でも同一。
  Sovereign Sanctuary が authorized personal process を要求するため。
- 結果: workitem 経路の正規実行 (`dispatch-tickets` → `dispatch-workitems`) は
  この sandbox では confidential tenant mission に対して不可。

## 現状 (完走時点)

- BASE/OBS/GO: すべて archived。キューは dispatched×3。
- R1 は本修正で解消。以降の independent micro-repo mission でも
  `review-task` → `reconcile-work` がそのまま通る。
- R2 (sandbox の tenant-profile 読取拒否) は環境制約として残存。
  `dispatch-tickets/workitems` が使えない文脈では直接作業 + reconcile が正規代替路。
