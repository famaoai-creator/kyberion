---
title: 稟議承認 標準運用手順書 (Ringi Approval SOP)
category: Common
tags: [common, operations, ringi, approval, sop]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# 稟議承認 標準運用手順書 (Ringi Approval SOP)

*Version: 1.0.0*
*Role: Line Manager*

## 1. 目的 (Objective)
Garoon Intra-Ringi システムにおける未承認の稟議・申請案件を、ブラウザ自動操作により一括で「巡回・内容抽出・承認」する。

## 2. 実行リソース (Prerequisites)
以下の 3 つの資産が正しく配置され、かつ **社内ネットワーク（VPN等）** に接続されている必要がある。

1.  **認証情報**: `knowledge/personal/connections/intra_ringi.json`
2.  **シナリオ**: `knowledge/personal/automation/scenarios/intra_ringi.yaml`
3.  **スキル**: `skills/utilities/browser-navigator` (ビルド済み)

## 3. 即時実行コマンド (Quick Start)
リポジトリルートから以下のコマンドを実行する。

```bash
node skills/utilities/browser-navigator/dist/index.js 
  --scenario=knowledge/personal/automation/scenarios/intra_ringi.yaml 
  --headless=false
```
※ 稟議の内容確認とポップアップ処理を確実に行うため、`headless=false` を推奨。

## 4. 承認フローの仕様 (Workflow Logic)
本手順は Garoon ワークフローの JSF 画面（Deecb0030.jsf）を直接操作する。

1.  **ログイン**: Garoon ポータル経由で自動ログイン。
2.  **遷移**: ワークフローの「受信一覧（未処理）」画面へ直接遷移。
3.  **フィルタリング**: 「【」「申請」「稟議」のキーワードを含むリンクを承認対象として特定。
4.  **巡回監査**: 各案件を開き、起票者や内容などの主要情報をレポート用に抽出。
5.  **承認執行**: 画面内の「承認」ボタンをクリックし、続く「OK/決定」ダイアログを自動で閉じる。
6.  **完了**: 全案件の処理結果を Markdown レポートとして出力。

## 5. 重点チェック観点 (Critical Notes)

### A. ネットワーク制約
- URL が `.local` ドメインのため、通常のインターネット回線からはアクセス不可。実行前に疎通を確認すること。

### B. フレームとタイムアウト
- ワークフロー画面はロードに時間がかかる場合がある。シナリオ内の `timeout: 15000` 以上の待機を推奨。
- `MEMORY_SENTINEL` 警告が出る場合は、ブラウザのキャッシュやタブの開きすぎに注意する（現在の `browser-navigator` は自動でパージを行う）。

## 6. エビデンスの出力
- 実行結果のサマリーは `active/missions/ringi_approval/` に記録可能。
- 承認した案件名と抽出情報は、スキルの `report` データとして不揮発に保存される。
