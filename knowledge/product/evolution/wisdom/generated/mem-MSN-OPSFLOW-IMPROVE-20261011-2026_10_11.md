---
record_id: mem-MSN-OPSFLOW-IMPROVE-20261011-2026_10_11
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-OPSFLOW-IMPROVE-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T10:35:57.219Z
source_branch: feat/opsflow-improve-20261011
source_commit: 0bf5bb5609243b07dd768425881c4d72c6f6e068
---

# 組織運用フロー摩擦の修正パターン（R1-R4）

Decision再起票、finish報告、reviewガイダンス、scope push/pop の4件のCLI/運用改善と検証方法。

## Hint Scope

mission

## Trigger Phrases

- # 組織運用フロー摩擦の修正パターン

- 滞留pending_approvalは同状態再起票（re_request）で新規承認要求を開く（deferred迂回は不要）。
- finishのgoal-gap dispatchはfreshなgate reasonを残し、archive未確認の誤報を出さない。
- review-taskはREVIEW文書の手順を次手として明示する。
- scopeの一時切替は push/pop で退避・復元する（上限10、clearで破棄）。
- type-ratchet上限に触れる場合は無理にbaselineを上げず、 helper抽出等の正直な縮減で対応する。
- golden失敗はクリーンツリー対照で環境由来を証明してからrebaseline判断する。

## Recommended References

- active/missions/public/MSN-OPSFLOW-IMPROVE-20261011/evidence/delivery-report.md

## Evidence

- active/missions/public/MSN-OPSFLOW-IMPROVE-20261011/evidence/delivery-report.md

## Artifacts
