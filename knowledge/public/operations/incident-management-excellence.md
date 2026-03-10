---
title: Incident Management & RCA Excellence Handbook
category: Operations
tags: [operations, incident, management, excellence]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Incident Management & RCA Excellence Handbook

このドキュメントは、障害発生時の迅速な復旧と、二度と同じ過ちを繰り返さないための「根本原因分析 (RCA)」および「障害報告」の標準規約である。

## 1. インシデント管理のライフサイクル (Life Cycle)

1.  **検知 (Detection)**: モニタリング、外形監視、またはユーザー報告。
2.  **初期対応 (Response)**: サービス復旧を最優先。回避策 (Workaround) の適用。
3.  **封じ込め (Containment)**: 被害拡大の防止（例：特定リージョンの切り離し）。
4.  **根本原因分析 (RCA)**: 「なぜ」を5回繰り返し、構造的欠陥を特定。
5.  **恒久対策 (Remediation)**: コード修正、アーキテクチャ変更、自動テスト追加。
6.  **報告 (Reporting)**: ステークホルダーへの透明性確保。

## 2. RCA (根本原因分析) メソドロジー

### なぜなぜ分析 (5-Whys)
一つの事象に対し、背後にある論理的な原因を深掘りする。
- **1st Why**: なぜシステムがダウンしたか？ -> メモリリークが発生した。
- **2nd Why**: なぜメモリリークが起きたか？ -> 未解決のPromiseが累積した。
- **3rd Why**: なぜPromiseが未解決のままか？ -> エラーハンドリングの catch 節がなかった。
- **4th Why**: なぜ catch 節がなかったか？ -> 新規追加された共通ライブラリの規約が徹底されていなかった。
- **5th Why (Root Cause)**: なぜ規約が徹底されていなかったか？ -> コードレビューの自動チェックに当該項目が含まれていなかった。

### 魚の骨分析 (Ishikawa Diagram)
- **人 (Man)**: スキル不足、手順ミス。
- **機械 (Machine)**: インフラ故障、リソース不足。
- **方法 (Method)**: 不適切なデプロイフロー、テスト不足。
- **材料 (Material)**: 依存ライブラリの脆弱性、データ破損。

## 3. 障害報告書 (Post-Mortem) の黄金律

良い報告書は「誰が悪いか」ではなく「何が悪いか」に焦点を当てる (Blameless Culture)。

### 推奨構成
1.  **要約 (Executive Summary)**: 非専門家でも1分で理解できる概要。
2.  **時系列 (Timeline)**: 検知から復旧までの分単位の記録。
3.  **影響範囲 (Impact)**: 影響を受けたユーザー数、機能、期間。
4.  **根本原因 (Root Cause)**: 5-Whys の結果。
5.  **再発防止策 (Action Items)**: 「気をつける」ではなく「仕組みで防ぐ」具体策。
6.  **教訓 (Lessons Learned)**: 今回のインシデントで得られた組織的知見。

## 4. AIによる自動化ポイント

- **ログからのTimeline生成**: 膨大なログから重要なイベントを抽出。
- **RCAドラフト生成**: エラーシグネチャに基づき、AIが 5-Whys を推論。
- **Action Itemのチケット化**: 報告書から直接 GitHub Issues や Jira へタスクを登録。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
