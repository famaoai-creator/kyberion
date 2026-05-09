---
title: Gateway Onboarding Protocol
category: Governance
tags: [gateway, onboarding, security, messenger]
importance: 9
author: Kyberion Ecosystem Architect
last_updated: 2026-05-04
---

# Gateway連携オンボーディング・プロトコル (Gateway Onboarding Protocol)

このプロトコルは、Kyberion エコシステムに新しい外部通信チャネル（Slack, Telegram, iMessage 等）を安全かつ統治された形で追加・設定するための標準手順を定義する。

## 1. 目的
単なる「機能の有効化」ではなく、物理実装から主権者による認証情報の付与までを段階的に進めることで、外部との通信チャネルに対する主権（Sovereignty）と安全性を担保すること。

## 2. 4段階のオンボーディング・プロセス

### Phase 1: 物理実装 (Satellite Implementation)
- **内容**: ターゲットとなる通信プロトコル（例: Telegram API）と対話するためのサテライト・プログラムを構築する。
- **実務**: `satellites/{service}-bridge/` 配下にコードを配置し、ビルドを完了させる。
- **ガバナンス**: この段階ではまだ外部との通信は行われず、プログラムとしての健全性のみが検証される。

### Phase 2: トポロジー登録 (Surface Registration)
- **内容**: システムが「新しい連絡経路」を認識できるように構成定義を更新する。
- **実務**: `knowledge/public/governance/surfaces/<surface-id>.json` にサービスID、種別（gateway）、起動コマンド、ポート等を追記する。`active-surfaces.json` は compatibility snapshot として自動生成される。
- **ガバナンス**: システムが管理対象として認識し、`runtimeSupervisor` の監視下に入る。

### Phase 3: 秘密の握手 (Secret Handshake / Credentials)
- **内容**: **主権者（ユーザー）の明示的な介入**により、APIトークン等の機密情報を安全に登録する。
- **実務**: `secret-guard` または専用の OAuth フローを介して、情報は `knowledge/personal/` ティア（個人機密）に隔離して保存される。
- **ガバナンス**: Kyberion は勝手にアカウントを作成せず、主権者から預かった「鍵」のみを使用する。

### Phase 4: 権限移譲と起動 (Mission Activation)
- **内容**: サービスを実際に起動し、メッセージの送受信を開始する。
- **実務**: `pnpm surfaces:reconcile` を実行。システムは「コード」「設定」「鍵」が全て揃っていることを検証し、バックグラウンドプロセスを立ち上げる。
- **ガバナンス**: 全ての通信はログに記録され、ガバナンスポリシー（Tier衛生）の監視を受ける。

## 3. ユーザー依頼のシナリオ (Example Intents)

主権者は、以下のような自然言語による依頼を通じて、このプロトコルを起動させることができる。

| ユーザーの依頼 | Kyberion の応答とアクション |
|---|---|
| 「Telegramで話せるようにして」 | プロトコルの開始。Phase 1-2 の準備状況を確認し、Phase 3 のトークン入力を CEO に案内する。 |
| 「メッセージング連携を修復して」 | 既存の連携の不備を調査。Phase 1-2 の不備（コードの破損等）は自動修復し、Phase 3 の不備（トークン切れ）は再入力を求める。 |
| 「すべての外部連携を一時停止して」 | Phase 4 の権限を一時的に剥奪し、サービスを安全に SIGTERM 停止させる。 |

## 4. 運用上の注意
- **データの隔離**: ゲートウェイを介して届いたメッセージは、その重要度に応じて適切なナレッジティア（Confidential / Personal）に振り分けられる必要がある。
- **ゾンビプロセスの防止**: プロセスが異常終了した場合は、`pnpm surfaces:reconcile` が自動で Phase 4 を再試行し、回復を試みる。

---
*Status: Living Governance Document for Multi-Channel Expansion*
