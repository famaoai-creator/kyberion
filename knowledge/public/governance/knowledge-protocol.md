---
title: ハイブリッド・ナレッジ・プロトコル (3-Tier Sovereign Model)
category: Orchestration
tags: [orchestration, knowledge, protocol]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# ハイブリッド・ナレッジ・プロトコル (3-Tier Sovereign Model)

本モノレポの全スキルが遵守すべき、ナレッジの階層構造と取り扱い基準。

## 1. ナレッジおよびミッションの階層 (Tier)

1. **Public Tier (`knowledge/`, `active/missions/public/`)**: 汎用基準。GitHub同期。
2. **Confidential Tier (`knowledge/confidential/`, `active/missions/confidential/`)**: 会社・プロジェクト共有の秘密。外部Git管理。
   - **Skill-Specific**: `.../skills/<skill-name>/`
   - **Client-Specific**: `.../clients/<client-name>/`
3. **Personal Tier (`knowledge/personal/`, `knowledge/personal/missions/`)**: 完全にローカル。**メインGit管理禁止**。個人の秘密鍵、APIキー、主権者の「魂」。

## 2. ティアの自動判定と隔離 (Isolation Enforcement)

- **ミッション・ティアの継承**: ミッションが参照する `knowledge_injections` に上位ティアのパスが含まれる場合、ミッション自体の実行ティアも自動的に引き上げられる。
- **独立履歴 (Micro-Git)**: 各ミッションはディレクトリ内に独自の `.git` を持ち、メインリポジトリの歴史から物理的に隔離される。これにより、試行錯誤の過程や機密データがメインリポジトリに混入することを防止する。

## 3. スキルの行動原則 (Core Logic)

- **優先順位 (Precedence)**: 同じ定義がある場合、以下の順で優先適用する。
  1. **Personal Tier** (個人の設定が最優先)
  2. **Confidential Tier (Client-Specific)** (クライアント固有設定)
  3. **Confidential Tier (Skill-Specific/General)** (会社標準)
  4. **Public Tier** (一般標準)
- **透過的参照**: 実行時、スキルは自動的に全 Tier を統合して最適なコンテキストを構築する。
- **機密保護 (Tier-Aware Output)**:
  - 外部公開物には Public Tier 以外の情報を直接含めてはならない。
  - Personal/Confidential 情報を利用した場合は、必ず「抽象化・匿名化」を行うこと。

## 3. クライアント・コンテキストの切り替え

- `mission-control` に対し「Client X として実行せよ」と命じることで、`knowledge/confidential/clients/ClientX/` がコンテキストの最上位にセットされる。
