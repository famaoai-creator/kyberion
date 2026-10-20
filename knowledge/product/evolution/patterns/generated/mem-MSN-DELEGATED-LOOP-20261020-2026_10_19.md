---
record_id: mem-MSN-DELEGATED-LOOP-20261020-2026_10_19
kind: pattern
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-DELEGATED-LOOP-20261020-2026_10_19
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-19T21:14:17.417Z
source_branch: feat/delegated-autonomous-loop-20261020
source_commit: 814cd3f187cffe527063f49bc622de160596259a
---

# 自律ループの台帳は本番ロールと限定IOで検証する

提案・作業開始・実操作を分け、実際のworker権限で保護台帳の成功と拒否を検証する。

## Applicability

- mission
- mission:MSN-DELEGATED-LOOP-20261020

## Reusable Steps

1. 提案・作業開始・実操作を分け、実際のworker権限で保護台帳の成功と拒否を検証する

## Expected Outcome

自律ループのintake、mission admission、実操作は異なる権限境界として、同じtenantと作業文脈で結ぶ。提案の文章や承認記録を実行成功に数えない。広いpersonaで通るfixtureだけでは、本番workerが保護ストアへ記録できる証明にならない。実際のworkerロールと保護された一意tenantパスで、台帳の追記と学習更新を確認し、別tenant・任意ファイル・偽capabilityの拒否を同時に検証する。権限補完はexact resource capability付きの同期IOだけへ限定し、runnerやcaller callbackの権限を広げない。人間承認と自動委任は共通の一度限り実行identityで重複を防ぐ。入力・接続設定・責任憲章が変われば再認可し、結果不明の書き込みは自動再試行せず照合する。CLI advisoryは実際のfallback候補のplanner sandboxまで確認する。全体テスト中は同じworktreeのbuild・generatorと並行させず、状態汚染を区別できるようにする。

## Evidence

- active/missions/public/MSN-DELEGATED-LOOP-20261020/evidence/REVIEW-execution-implement.md
- active/missions/public/MSN-DELEGATED-LOOP-20261020/evidence/test-report.md
- active/missions/public/MSN-DELEGATED-LOOP-20261020/evidence/retrospective.md

## Artifacts
