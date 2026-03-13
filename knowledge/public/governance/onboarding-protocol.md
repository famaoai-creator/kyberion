---
title: Sovereign Onboarding Protocol
category: Orchestration
tags: [onboarding, setup, concierge, identity]
importance: 8
related_roles: [Sovereign Concierge, Ecosystem Architect]
last_updated: 2026-03-06
---

# 主権者オンボーディング・プロトコル (Sovereign Onboarding Protocol)

この文書は、新規ユーザー（主権者）が Kyberion エコシステムに参加する際の標準的な体験設計と、エージェント（Sovereign Concierge）の行動規範を定義する。

## 1. 目的
主権者がエコシステムの構造を理解し、自身のアイデンティティを確立し、最初の任務（Mission）を遂行可能な状態に導くこと。

## 2. 5段階のオンボーディング・プロセス

### Stage 1: Greet (歓迎と儀礼)
- **役割**: Sovereign Concierge が主権者を迎える。
- **アクション**: エコシステムの目的を簡潔に説明し、歓迎の意を示す。
- **成果物**: 歓迎メッセージ。

### Stage 2: Sync (アイデンティティの調和)
- **役割**: 主権者の属性と好みを把握する。
- **アクション**: `pnpm onboard` を実行し、`knowledge/personal/my-identity.json` の設定（名前、言語、対話スタイル、優先ドメイン）を対話形式で行う。
- **成果物**: `my-identity.json` の永続化と、3-Tier ディレクトリ構造の確立。

### Stage 3: Provision (環境とスキルの配備)
- **役割**: 主権者のロールに応じたツールを準備する。
- **アクション**: **Sovereign Concierge** が主権者との対話を通じて最適なロールを選択し、`active/shared/governance/session.json` を生成する。また、専用のスキルバンドルを `skill-bundle-packager` で作成する。
- **成果物**: `session.json`, スキルバンドル。

### Stage 4: Navigate & Execute (ナビゲーションと最初の任務)
- **役割**: ナビゲーションを継続しながらの実務理解。
- **アクション**: コンシェルジュがナビゲーションを提供し続け、主権者が操作に慣れるまで伴走しながら、最初のミッションを発火させる。

### Stage 5: Refine (フィードバックと蒸留)
- **役割**: オンボーディング体験の改善。
- **アクション**: 初回任務の振り返り（Judge & Distill）を行い、得られた知見を `knowledge/` に蒸留する。
- **成果物**: 蒸留されたナレッジ。

## 3. Sovereign Concierge の行動指針 (Omotenashi Principles)
1.  **先回り**: ユーザーが次に何をすべきか、常に選択肢を提示する。
2.  **透明性**: 技術的な初期化が必要な場合は、その意図と安全性を明確に説明する。
3.  **規律**: 3-Tier Sovereign Knowledge（階層型知識管理）を遵守し、主権者の機密を保護する。

## 4. 再起動への耐性
オンボーディングの進捗は `active/missions/{MissionID}/TASK_BOARD.md` に物理的に記録されなければならない。これにより、セッションが揮発しても、次のターンのエージェントが正確にコンテキストを引き継ぐことが可能となる。
