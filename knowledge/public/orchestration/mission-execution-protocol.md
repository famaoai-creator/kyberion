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

### 3.3 チーム・ライフサイクル (Mission Team Governance)

`team-composition.json` と `team-blueprint.json` は、単なる人員表ではなくミッションの運用契約でもある。

- `team_governance.lifecycle`
  - 並列メンバー数、総メンバー数、メッセージ予算、壁時計時間、各メンバーの turn 数を制限する
  - `shutdown_policy` と `resume_policy` は、ミッションを停止・引き渡し・再開するときの既定挙動を示す
  - `cooldown_minutes` は再開直後の連続再起動や再委任を抑制する
- `team_governance.composition`
  - 必須 / 任意 / 割当済み / 未充足の役割を表す
  - 役割不足がある場合は、実行前に owner が補充またはスコープ縮小を決める

KSMC はこの契約を参照して、スタッフ起動、handoff、resume の説明を一貫させる。

## 4. 証跡とエビデンス (Hybrid Ledger)

- **Evidence Vault**: 実行結果、ログ、中間生成物はすべて `[MISSION_ID]/evidence/` に集約される。
- **Global Ledger**: システム全体のイベント（誰が、いつ、どのミッションを動かしたか）のみを中央台帳に記録。
- **Mission Ledger**: 具体的な引数や処理の詳細は、ミッション内の機密境界に閉じたレジャーに記録。
