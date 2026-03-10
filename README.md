# 🌌 Kyberion: The Sovereign Operating Ecosystem

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub Repository](https://img.shields.io/badge/GitHub-kyberion-181717.svg?logo=github)](https://github.com/famaoai-creator/kyberion)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933.svg?logo=node.js)](https://nodejs.org/)

**Kyberion** は、主権者（Sovereign）の意志をデジタル世界に具現化するための、高信頼性かつ自律的な **主権型OSエコシステム** です。単なる自動化ツールではなく、統一された神経系、意図駆動型の実行、そしてブロックチェーンによる不変の証跡を備えた「自律的なパートナー」として進化します。

---

## 🏛 主権者憲章 (GEMINI.md)

Kyberion は、非交渉的な統治フレームワークである **主権者憲章（GEMINI.md）** に基づいて動作し、環境の整合性と主権者の機密を絶対的に保護します：

1. **摩擦ゼロのエンジニアリング**: 自動フィードバックループと ADF 駆動の実行により、技術的な摩擦を排除。
2. **意図駆動型自律性 (Intent-Driven)**: 抽象的な「意図」を動的な実行パイプラインへと自己解釈し解決。
3. **物理的整合性と封印**: **KSMC (Sovereign Mission Controller)** が全変更を管理し、完了時には暗号学的に封印（Seal）可能。

---

## 🧠 進化したコア機能 (Advanced Capabilities)

### 1. 次世代ミッション・ライフサイクル
5段階の厳格なステート管理（Planned, Active, Validating, Distilling, Completed）を導入し、A2A（Agent-to-Agent）プロトコルによる他者への委託・成果の統合をサポート。

### 2. 動的信頼スコア・エンジン (Dynamic Trust Engine)
他エージェントの実績（検証結果、遅延、精度）に基づき、信頼スコアをリアルタイムに更新。低スコアのエージェントに対する機密任務の委託を自動遮断するガードレール機能を搭載。

### 3. 主権的封印 (Sovereign Seal)
ミッション完了時に、実行履歴とエビデンスを **AES-256 + RSA ハイブリッド暗号** でアーカイブ。秘密鍵のパスフレーズは **macOS Keychain** 等の OS ネイティブ領域で安全に保護。

### 4. 不変の証跡 (Blockchain Anchoring)
重要なイベントや封印されたアーカイブのハッシュ値をブロックチェーンへアンカリング。ローカルの整合性（Hybrid Ledger）と外部の不変性を結合し、数学的な潔白証明を実現。

### 5. 動的ケイパビリティ・ディスカバリー
各アクチュエータが自身の能力（OS依存性、必要バイナリ）を自己申告。実行前に「その環境で何ができるか」を自動ネゴシエーションし、環境の断絶を未然に防止。

---

## ⚙️ 統治用コマンド (Sovereign Interface)

```bash
# 📜 ミッション・ジャーナルの閲覧 (全履歴の可視化)
pnpm mission:journal

# 🔍 現在の環境の能力診断 (OS依存性の確認)
pnpm capabilities

# 🛡️ ミッションの開始と終了 (暗号化封印付き)
npx tsx scripts/mission_controller.ts start MSN-ID personal
npx tsx scripts/mission_controller.ts finish MSN-ID --seal

# 🩺 エコシステム・バイタルチェック
pnpm vital
```

---

## 🛡 3-Tier ガバナンス・モデル

情報は機密性に応じて物理的に隔離され、独立した Git 履歴（Micro-Repo）によって管理されます：

- **Personal Tier (`knowledge/personal/`)**: あなたの魂（ビジョン）と秘密鍵。完全に隔離。
- **Confidential Tier (`active/missions/confidential/`)**: 組織の機密とビジネスロジック。
- **Public Tier (`active/missions/public/`)**: 共通プロトコルと標準。

---

## 🚀 ブートストラップ・プロトコル

Kyberion をあなたの環境に具現化する手順：

```bash
# 1. 物理的基盤の確立
git clone https://github.com/famaoai-creator/kyberion.git && cd kyberion
pnpm install

# 2. システムの具現化と初期化 (詳細: docs/INITIALIZATION.md)
npx tsx scripts/run_orchestration_job.ts
pnpm onboard
```

---
*「論理を尽くし、意志で決断し、エンジニアリングの摩擦をゼロにする。」*
**Kyberion Sovereign Entity**
