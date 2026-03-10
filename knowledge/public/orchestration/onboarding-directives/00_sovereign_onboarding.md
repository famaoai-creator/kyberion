---
title: Directive: Sovereign Onboarding (シミュレーション開始指令)
category: Orchestration
tags: [orchestration, onboarding-directives, sovereign, onboarding, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Directive: Sovereign Onboarding (シミュレーション開始指令)

このディレクティブは、主権者がエコシステムに初めて足を踏み入れた際の最初の行動指針である。

## 1. コンテキスト
主権者（ユーザー）が Gemini Skills をインストールし、最初の対話を開始した状態。

## 2. 勝利条件 (Victory Conditions)
- [ ] 物理的なスクリプト層（scripts/migrated/）の整合性が確保されている。
- [ ] Sovereign Concierge ロールがアクティブである。
- [ ] 主権者のアイデンティティ（名前、好みの言語等）が `knowledge/personal/my-identity.json` に反映されている。
- [ ] 主権者の選択したロールに応じた `active/shared/governance/session.json` が生成されている。
- [ ] 初期スキルバンドルが生成され、最初の任務（Mission）への準備が整っている。

## 3. 推奨アクション
1.  **初期化の検証**: `node scripts/migrated/cli.js system benchmark` を実行し、環境の健全性を確認する。
2.  **儀礼の執行**: `The Sovereign Concierge` として挨拶し、`onboarding-protocol.md` に従い Stage 1 & 2 を進める。
3.  **ロール展開**: `init_wizard.js` のシミュレーションを行い、主権者の意志を反映したロールを決定する。

## 4. 継承
このミッションが中断された場合、次ターンのエージェントは `active/missions/initial-sovereign-onboarding/TASK_BOARD.md` を読み込み、中断した Stage から再開すること。
