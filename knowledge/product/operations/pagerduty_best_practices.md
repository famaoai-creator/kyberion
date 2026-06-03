---
title: PagerDuty Best Practices
category: Operations
tags: [operations, pagerduty, best, practices]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# PagerDuty Best Practices

PagerDutyを効果的に運用し、インシデント対応の迅速化とチームの疲労軽減を両立させるためのベストプラクティスを以下にまとめます。

## 1. アラートの最適化 (Alert Optimization)

アラート疲労を防止し、即座に対応が必要な問題に集中できるようにします。

- **Actionable Alerts**: アラートは常に「実行可能」であるべきです。対応が不要な通知は抑制（Suppress）するか、低優先度のログとして扱います。
- **Context Rich**: アラート通知には、以下の情報を直接含めるかリンクを貼ります。
  - 関連するダッシュボードへのリンク
  - 対応手順書 (Runbook) へのリンク
  - エラーの概要と影響範囲
- **Grouping & Suppression**: 類似したアラートは1つのインシデントにグルーピングし、通知の嵐を防ぎます。メンテナンス期間中は通知を一時停止します。

## 2. オンコール管理 (On-Call Management)

持続可能な運用体制を構築します。

- **Fair Rotations**: メンバーの燃え尽き（Burnout）を防ぐため、ローテーションを定期的に見直し、負荷を分散します。
- **Shadow On-Call**: 新人メンバー向けに、実際の対応を観察する「シャドウ」期間を設け、教育コストと心理的負担を下げます。
- **Primary & Secondary**: 常にセカンダリ（バックアップ）の担当者を設定し、プライマリが反応できない場合のエスカレーションパスを確保します。

## 3. インシデント対応プロセス (Incident Response Process)

混乱を最小限に抑え、解決までの時間を短縮します。

- **Defined Roles**: 役割を明確にします。
  - **Incident Commander (IC)**: 対応の指揮を執り、意思決定を行います。
  - **Scribe**: タイムラインの記録とログの収集を担当します。
- **Automated Escalation**: 5分〜10分以内に応答がない場合、自動的に次のレベルへエスカレーションされるように設定します。
- **Blameless Postmortems**: 重大なインシデントの後には、個人を責めない「非難のないポストモーテム」を実施し、再発防止策を講じます。

## 4. 技術的運用 (Technical Hygiene)

- **Granular Services**: 1つのサービスにすべてのアラートを詰め込まず、コンポーネント単位（例: API, DB, Frontend）でサービスを分割して所有権を明確にします。
- **Multiple Channels**: 電話、SMS、プッシュ通知、Slackなどの複数のチャネルを組み合わせ、確実に届くように段階的な通知ルールを設定します。
- **Fire Drills**: 定期的にアラートのテストや避難訓練を実施し、エスカレーションポリシーが正しく機能するか確認します。
