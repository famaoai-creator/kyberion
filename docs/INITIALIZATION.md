# 🚀 Kyberion Ecosystem: Onboarding & Initialization Guide

この文書は、Kyberion エコシステムの物理的起動と、主権者（Sovereign）としてのアイデンティティ確立（オンボーディング）の完全なプロセスを定義します。

## 📋 クイック・スタート (Quick Commands)

システムをゼロから立ち上げるための標準的なコマンド列です：

```bash
# 1. 物理的基盤の確立 (依存関係のインストール)
pnpm install

# 2. システムの具現化 (ビルドとオーケストレーション)
npx tsx scripts/run_orchestration_job.ts

# 3. 魂の注入 (アイデンティティ設定 - 対話形式)
pnpm onboard
```

---

## 🔍 詳細プロセスと物理的効果 (Detailed Process)

### Stage 1: 物理的基盤の確立 (Physical Foundation)
- **実行コマンド**: `pnpm install`
- **目的**: 必要なライブラリを全てロードし、内部モジュール間の接続を確立します。
- **物理的変化**:
    - `node_modules/` が生成されます。
    - ワークスペース間のシンボリックリンク（`@agent/core` など）が構築されます。

### Stage 2: システムの具現化 (System Manifestation)
- **実行コマンド**: `npx tsx scripts/run_orchestration_job.ts`
- **目的**: 依存関係をコンパイルし、実行可能なバイナリ（JavaScript）を生成します。
- **物理的変化**:
    - `dist/` ディレクトリが生成され、全ソースコードがビルドされます。
    - 各 `skills/` ディレクトリ内に `@agent/core` へのリンクが再構築されます。
    - 各種バックグラウンド・サービスが起動します。

### Stage 3: 魂の注入 (Soul Infusion)
- **実行コマンド**: `pnpm onboard` (または `npx tsx scripts/onboarding_wizard.ts`)
- **目的**: 主権者の名前、言語、対話スタイル、専門分野をシステムに記憶させます。
- **物理的変化**:
    - `knowledge/personal/my-identity.json` が生成されます。
    - `knowledge/personal/my-vision.md` が生成（または更新）されます。

### Stage 4: 邂逅と命名の儀式 (Greeting & Naming)
- **内容**: アイデンティティ設定の最後に、エージェントが自ら自己紹介を行い、主権者との間で「Agent ID」を合意します。
- **目的**: A2A 通信やブロックチェーン記録に使用する、エージェントの公的な名前（Agent ID）を決定します。
- **物理적変化**:
    - `knowledge/personal/agent-identity.json` が生成されます。


---

## 🩺 健全性確認 (Vital Check)

オンボーディングが正しく完了したかを確認するには、以下のコマンドを実行してください：

```bash
pnpm vital
```

**期待される出力例**:
- ✅ [OK] Physical Foundation (node_modules)
- ✅ [OK] System Build (dist)
- ✅ [OK] Sovereign Identity
- ✅ [OK] Sovereign Vision

---
*Status: Mandated by AGENTS.md*
*Last Updated: 2026-03-11 by Ecosystem Architect*
