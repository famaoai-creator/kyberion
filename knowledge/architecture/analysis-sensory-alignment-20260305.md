---
title: Analysis: Sensory Bridge Alignment (2026-03-05)
category: Architecture
tags: [architecture, analysis, sensory, alignment, 20260305]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Analysis: Sensory Bridge Alignment (2026-03-05)

本ドキュメントは、感覚ブリッジ（Sensory Bridge）の物理実装完了に伴う、アーキテクチャの最適化に関する検討状況を記録したものである。

## 1. 確定事項 (Consensus Reached)
以下の要素は物理的に実装され、動作が検証済みである。
- **GUSP v1.0**: 統一感覚プロトコルの採択。
- **API-Driven Hub**: `/inject` API による、Ink/TUI 対応のタイピング注入。
- **Autonomous Feedback**: アイドル検知による自動的な Slack 返信ループ。

## 2. 継続検討事項 (Under Consideration)

主権者 famao 様との協議により、以下の課題が「検討中」として保留されている。

### 2.1 物理配置の最適化 (Storage Location)
- **現状**: `active/shared/` や `presence/bridge/` に実行時データ（刺激と応答）が点在している。
- **論点**: 
    - **SRE 観点**: IO 競合や Git 汚染を防ぐため、`active/`（成果物）から完全に隔離し、ランタイム専用領域（`tmp/` や `var/`）へ移行すべきか。
    - **ナレッジ観点**: 生データ（Raw）から蒸留知（Intel）への昇華プロセスを物理パスで表現すべきか。

### 2.2 プロジェクトのデカップリング (Decoupling)
- **案**: `kyberion` (脳) と `gemini-presence` (神経系) を別プロジェクト（リポジトリ）に分離する。
- **メリット**: インフラとしての汎用化、開発サイクルの独立、安定性の確保。
- **デメリット**: 構成管理の複雑化、コンテキストの断絶。

### 2.3 シークレット管理のジレンマ (Secret Management)
- **課題**: 「外部との接点」は API キー等のシークレット情報の塊である。分離した場合、これらをどう安全かつ簡便に共有・管理するか。
- **検討中のシナリオ**:
    1. **The Vault Mount**: OS レベルの固定位置（金庫）を各プロジェクトが参照する。
    2. **The Configuration Nerve**: Presence 側を完全非公開の「接続専用機」とする。
    3. **Dual-Key Sync**: `sovereign-sync` を使い、単一リポジトリ内でファイル単位の物理隔離を行う。

## 3. 次のステップへの問い
「ソースコードの配置場所」と「実行データの位置」を一致させるべきか否か。そして、シークレットの呪縛を解きつつ、いかにして「疎結合な受肉」を果たすか。

---
**Status**: `PENDING_ALIGNMENT` (主権者による熟考フェーズ)
**Target Date for Next Review**: N/A
