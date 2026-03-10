---
title: ミッション実行規程 (Mission Execution Protocol v2.0)
category: Orchestration
tags: [orchestration, mission, execution, protocol, security]
importance: 10
author: Kyberion Sovereign Entity
last_updated: 2026-03-10
---

# ミッション実行規程 (Mission Execution Protocol v2.0)

## 1. 動作レイヤーの分離定義

### 1.1 大脳レイヤー (Reasoning: AI Persona)

- **入力**: ユーザーの意図、Publicナレッジ、実行ログ。
- **処理**: ロールに基づく戦略立案、パラメータの特定、`MissionContract` の生成。
- **制約**: コンテキストウィンドウの肥大化を防ぐため、詳細な実行ログやバイナリデータは保持せず、Evidenceへのポインタのみを扱う。

### 1.2 脊髄レイヤー (Reflex: Mission Control / KSMC)

- **入力**: `MissionContract` (JSON), 3-Tier ナレッジ。
- **処理**:
  1. **ティア判定**: 注入されるナレッジに基づき、ミッションの機密ティアを自動決定（Escalation）。
  2. **リポジトリ初期化**: 独立した Micro-Git リポジトリをミッションディレクトリ内に生成。
  3. **決定的実行**: スクリプトの実行と、チェックポイントによる履歴の記録。
  4. **証跡記録**: Hybrid Ledger へのメタデータ（Global）と詳細ログ（Mission）の書き込み。
- **制約**: システム本体の Git 履歴には一切干渉せず、独立した物理境界内でのみ動作する。

## 2. 3-Tier ミッション・アーキテクチャ

ミッションは、その性質と使用する情報資産に基づき以下の3つのティアに分類される。

| ティア | 格納パス | 保護レベル | 履歴管理 |
| :--- | :--- | :--- | :--- |
| **Personal** | `knowledge/personal/missions/` | **Secret** (主権者の魂) | 独立リポジトリ (Git非追跡) |
| **Confidential** | `active/missions/confidential/` | **Confidential** (組織機密) | 独立リポジトリ (Git非追跡) |
| **Public** | `active/missions/public/` | **Public** (標準・公開) | 独立リポジトリ (Git追跡可) |

## 3. トランザクションと整合性 (Sovereign Shield)

### 3.1 独立リポジトリ (Micro-Repo)
すべてのミッションは開始時に独自の `git init` を行い、メインシステムとは独立した歴史を持つ。これにより、試行錯誤の過程がシステムコアを汚染することを物理的に防止する。

### 3.2 チェックポイント (Checkpoint)
主要なタスクの完了ごとに `checkpoint` コマンドを実行し、ミッション固有の歴史に刻む。失敗時には、メインシステムに影響を与えることなく、ミッション内部の状態のみを過去のチェックポイントへロールバック可能。

## 4. 証跡とエビデンス (Hybrid Ledger)

- **Evidence Vault**: 実行結果、ログ、中間生成物はすべて `[MISSION_ID]/evidence/` に集約される。
- **Global Ledger**: システム全体のイベント（誰が、いつ、どのミッションを動かしたか）のみを中央台帳に記録。
- **Mission Ledger**: 具体的な引数や処理の詳細は、ミッション内の機密境界に閉じたレジャーに記録。
