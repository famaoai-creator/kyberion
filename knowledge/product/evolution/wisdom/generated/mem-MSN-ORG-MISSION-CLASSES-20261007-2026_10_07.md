---
record_id: mem-MSN-ORG-MISSION-CLASSES-20261007-2026_10_07
kind: knowledge_hint
tier: public
knowledge_domain: product
owner_nhi: ''
candidate_id: mem-MSN-ORG-MISSION-CLASSES-20261007-2026_10_07
supersedes: ''
superseded_by: ''
project_id: ''
task_session_id: ''
specialist_id: ''
locale: ''
created_at: 2026-10-07T03:01:01.991Z
source_branch: feat/org-mission-classes-20261007
source_commit: ce7adc6e7d480bfa2ec9962be13d53f1aceba11d
---

# 組織クラス追加と分類評価の改善サイクルの教訓

分類は先にベースラインを測り、dev/holdout/負例に分けて評価する。部分一致パターンの短い一般語は吸い込みを生む。

## Hint Scope

mission

## Trigger Phrases

- - 分類ルールに当たらない意図は既定値 code_change に落ちる。ontology の宣言クラスを mission 形意図に限って参照すると是正できる(task 形の汎用推論意図まで広げると通常のコード依頼が意思決定クラスへ引きずられる)。
- 調整済みデータのスコアは汎化の証拠にならない。未調整の holdout を追加すると一度下がるのが正しい挙動で、その後に汎化可能な範囲だけ補強する。
- utterance_patterns は小文字化した部分一致。nda⊂agenda、acquisition⊂data acquisition、倉庫⊂データ倉庫 のように短い一般語は無関係な依頼を吸う。独立レビューで出た入力は負例(neg)としてコーパスに固定する。
- 意図解決の同点処理などグローバルなロジック変更は golden シナリオを壊しうる。データ側で直せるならデータで直す。
- 詳細: knowledge/product/orchestration/mission-class-operating-guide.md §4

## Recommended References

- active/missions/public/MSN-ORG-MISSION-CLASSES-20261007/evidence/retrospective.md
- active/missions/public/MSN-ORG-MISSION-CLASSES-20261007/evidence/test-report.md

## Evidence

- active/missions/public/MSN-ORG-MISSION-CLASSES-20261007/evidence/retrospective.md
- active/missions/public/MSN-ORG-MISSION-CLASSES-20261007/evidence/test-report.md

## Artifacts
