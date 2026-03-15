---
title: MISSION: Skill Usage & Performance Audit
category: Orchestration
tags: [orchestration, onboarding-directives, arch, steward]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# MISSION: Skill Usage & Performance Audit

- **FROM**: Ecosystem Architect
- **TO**: Knowledge Steward
- **STATUS**: Issued

## 1. 目的

エコシステムのボトルネックを特定し、構造改善の優先順位を決定するため、スキルの利用実績データを収集する。

## 2. コンテキスト & リソース

- `active/shared/logs/` (過去の実行ログ)
- `knowledge/public/orchestration/global_actuator_index.json`

## 3. 勝利条件

- [ ] 最も頻繁に使用されるスキルと、失敗率の高いスキルのリストが作成されている。
- [ ] スキル間の暗黙的な依存関係（requireパターン）が抽出されている。

## 5. アウトプット形式

- 保存先: `active/shared/outputs/ecosystem_health_metrics.json`
