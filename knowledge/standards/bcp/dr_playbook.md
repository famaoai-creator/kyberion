# Disaster Recovery & BCP Playbook

大規模システム障害が発生した際、AIエージェントが自律的に状況を統制するための標準手順。

## 1. 復旧目標 (DR Metrics)
- **RTO (Recovery Time Objective)**: 障害発生から「何時間」で復旧させるか。
- **RPO (Recovery Point Objective)**: 「どの時点」のデータまで戻すか（データ損失許容範囲）。
- **ACEへの適用**: RTO/RPO が要件を満たさないアーキテクチャ案は、SREロールが **S1判定** を下す。

## 2. インシデント発生時の 3-Step Action
1. **Detection & Triage**:
    - `PERFORMANCE_DASHBOARD` で異常を検知。即座にミッション ID を発行。
2. **Execution Guard Activation**:
    - 全並列ミッションを一時停止（Pause）し、リソースを「復旧（Restore）」へ全投入。
3. **Public Communication**:
    - `executive_briefing_standards.md` に従い、ステークホルダーへ「何が起きたか・いつ直るか・影響は何か」を即座にドラフト。

---
*Created: 2026-02-14 | Reliability Engineer*
