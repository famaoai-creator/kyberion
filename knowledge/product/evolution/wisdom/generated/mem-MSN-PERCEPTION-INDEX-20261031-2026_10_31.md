---
record_id: mem-MSN-PERCEPTION-INDEX-20261031-2026_10_31
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-PERCEPTION-INDEX-20261031-2026_10_31
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-31T11:08:42.150Z
source_branch: feat/cli-reliability-followup
source_commit: 5c1bf286bb85be874f1a8c17c6a68d771c6c07bb
---

# Extend a scoped role to the floors a feature legitimately needs

perception_media_worker を cache/<tier>/<tenant>/perception/ subtree に最小拡張し --index/--search を解決。新 grant は設計 doc の承認パッケージに沿った subtree-only tenant パラメータ化が定石

## Hint Scope

mission

## Trigger Phrases

- 残件解消の型: (1) 実 path を trace (resolveStorageFloor 起点)、(2) 既存 role へ最小 grant 追加 (exact subtree, tenant パラメータ化)、(3) wrap は同一 helper を再利用、(4) registry は generator 経由、(5) 負例で拡大なしを実証。read 無保護の floor には grant 不要 — 文書化で済ませる判断も含む。

## Recommended References

- active/missions/public/MSN-PERCEPTION-INDEX-20261031/evidence/implementation-report.md
- active/missions/public/MSN-PERCEPTION-INDEX-20261031/evidence/REVIEW-execution-implement.md

## Evidence

- active/missions/public/MSN-PERCEPTION-INDEX-20261031/evidence/implementation-report.md
- active/missions/public/MSN-PERCEPTION-INDEX-20261031/evidence/REVIEW-execution-implement.md

## Artifacts
