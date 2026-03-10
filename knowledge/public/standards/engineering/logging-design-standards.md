---
title: Logging Design & Observability Standards
category: Standards
tags: [standards, engineering, logging, design]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Logging Design & Observability Standards

このドキュメントは、トラブルシューティングの効率化とシステムの可観測性（Observability）を向上させるための、ログ設計の標準規約である。

## 1. 構造化ログ (Structured Logging)

ログは人間だけでなく「機械（AI/分析ツール）」が読みやすい形式であるべき。原則として **JSON形式** で出力する。

### 必須フィールド
- `timestamp`: ISO 8601 形式（例：`2026-02-28T04:00:00.000Z`）。
- `level`: ログレベル（後述）。
- `message`: 事象の簡潔な要約。
- `correlation_id`: リクエストを一貫して追跡するためのID（分散トレーシングに必須）。
    - **実装案**: Node.js では `AsyncLocalStorage` を使用して、リクエストスコープ内で ID を自動保持・伝搬させる。
- `service_name`: 出力元のサービス名。
- `user_id`: ユーザーコンテキスト（存在する場合）。

## 2. ログレベルの使い分け

| レベル | 意味 | アクション |
| :--- | :--- | :--- |
| **FATAL** | システムの継続が不可能な致命的エラー。 | 即時通報、サービス停止。 |
| **ERROR** | 特定のリクエストが失敗した重大な事象。 | 要調査。 |
| **WARN** | 異常ではないが、将来問題になる可能性がある（例：リトライ成功）。 | 定期的な確認を推奨。 |
| **INFO** | 重要なビジネスイベント（例：決済完了、ログイン）。 | 分析・監査に使用。 |
| **DEBUG** | 開発者向けのデバッグ情報。 | 本番環境では原則無効化。 |

## 3. PII (個人情報) の保護

ログに以下の情報を含めてはならない（またはマスク処理する）。
- パスワード、APIキー、シークレット。
- 氏名、メールアドレス、住所、電話番号。
- クレジットカード番号。

## 4. エラーコンテキストの付与

エラーログには、スタックトレースだけでなく、**「その時の状態（State）」** を含める。
- 例: 「注文失敗」だけでなく、「商品ID: X, 在庫数: 0」といった背景情報を付随させる。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
