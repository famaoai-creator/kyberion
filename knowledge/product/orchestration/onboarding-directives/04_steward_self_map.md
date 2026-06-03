---
title: MISSION: External System Connection Mapping
category: Orchestration
tags: [orchestration, onboarding-directives, steward, self, map]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# MISSION: External System Connection Mapping

- **FROM**: Knowledge Steward
- **TO**: Knowledge Steward
- **STATUS**: Issued

## 1. 目的

他ロールからのナレッジ収集依頼を遂行するため、Box, Google Workspace, GitHub, Slack 等の外部システムへの接続情報（API Endpoints, Credential Locations）を網羅的に把握・整理する。

## 2. コンテキスト & リソース

- `knowledge/connections/setup_guide.md`
- `knowledge/personal/` (秘密情報の所在確認)

## 3. 勝利条件

- [ ] 各システムへの「接続チェック（Health Check）」の結果がレポートされている。
- [ ] 必要なAPIキーやトークンが不足しているシステムのリストが作成されている。

## 4. 制約事項

- **Knowledge Tier**: 絶対に `Personal` 情報を `Public` に漏洩させないこと。
- **Tools**: `connection-manager` を使用して診断を行うこと。

## 5. アウトプット形式

- 保存先: `active/shared/outputs/system_connection_report.json`
