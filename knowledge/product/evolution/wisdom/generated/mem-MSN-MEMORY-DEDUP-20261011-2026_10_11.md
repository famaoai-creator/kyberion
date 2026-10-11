---
record_id: mem-MSN-MEMORY-DEDUP-20261011-2026_10_11
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-MEMORY-DEDUP-20261011-2026_10_11
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-11T11:45:00.007Z
source_branch: feat/memory-dedup-20261011
source_commit: edfcb427f5e9f6ef27977309f320ed03c23d2131
---

# promotion queue重複の根因と修正

distill/finish二重登録はscope不一致＋hashのみ照合が原因。identity統合とfinish同一化で解消。

## Hint Scope

mission

## Trigger Phrases

- # promotion queue重複の根因と修正

- distill経路（mission_id入りscope・tenant queue）とfinish経路（scopeなし・global queue）でscopeKeyが異なり、content_hashもsummary差で不一致 → 2行登録 → duplicate_recordsで承認不能。
- 修正: enqueueにcandidate_id+scopeKey(+tier+source_ref)のidentity統合を追加（保持要約のhash一貫、統合行をtier検証）。finishはdistill同一のcandidateIdとscopeを渡す。
- 既存重複はrecovery手順（reject --all-duplicates → R1再登録）で解消。日跨ぎは対象外。

## Recommended References

- active/missions/public/MSN-MEMORY-DEDUP-20261011/evidence/delivery-report.md

## Evidence

- active/missions/public/MSN-MEMORY-DEDUP-20261011/evidence/delivery-report.md

## Artifacts
