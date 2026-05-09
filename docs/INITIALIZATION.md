# 🚀 Kyberion Ecosystem: Onboarding & Initialization Guide

この文書は、Kyberion エコシステムの物理的起動と、主権者（Sovereign）としてのアイデンティティ確立（オンボーディング）の完全なプロセスを定義します。

## 📋 クイック・スタート (Quick Commands)

システムをゼロから立ち上げるための標準的なコマンド列です。

前提:
- Node.js `22+`
- `pnpm`

```bash
# 1. 物理的基盤の確立 (依存関係のインストール)
pnpm install

# 2. システムの具現化 (ビルド)
pnpm build

# 3. バックグラウンド surface の整列
pnpm surfaces:reconcile

# 4. 魂の注入 (オンボーディング)
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
- **実行コマンド**: `pnpm build`
- **目的**: 依存関係をコンパイルし、実行可能なバイナリ（JavaScript）を生成します。
- **物理的変化**:
  - `dist/` ディレクトリが生成され、全ソースコードがビルドされます。
  - `presence/displays/chronos-mirror-v2/.next/` が生成されます（`build:ui` step）。
  - workspace 間の runtime contract が再構築されます。
- **ステップ構成**: `build:packages` → `build:actuators` → `build:repo` → `build:ui`。
  個別実行する場合は `pnpm build:ui` のみで Chronos UI を再ビルドできます。

### Stage 3: Runtime Surface Reconciliation
- **実行コマンド**: `pnpm surfaces:reconcile`
- **目的**: `slack-bridge`、`imessage-bridge`、`discord-bridge`、`telegram-bridge`、`chronos-mirror-v2`、`nexus-daemon`、`terminal-bridge` などの background surface を manifest から標準起動します。
- **物理的変化**:
  - `active/shared/runtime/surfaces/state.json` が生成または更新されます。
  - `active/shared/logs/surfaces/` に surface ごとのログが出力されます。
  - `runtime-supervisor` に surface runtime が登録されます。
- **補助コマンド**:
  - `pnpm surfaces:status` で起動状態を確認できます。
  - `pnpm surfaces:start -- --surface <surface-id>` で個別 surface を開始できます。
  - `pnpm surfaces:stop -- --surface <surface-id>` で個別 surface を停止できます。

### Stage 4: 魂の注入 (Soul Infusion)
- **実行コマンド**: `pnpm onboard` (または `node dist/scripts/onboarding_wizard.js`)
- **目的**: 主権者の名前、言語、対話スタイル、専門分野、vision をシステムに記憶させます。
- **非対話環境の場合**: TTY が無い環境では `pnpm onboard` は exit 2 で停止します。代わりに以下のいずれかを使用:
  - `pnpm onboard:apply --identity <path/to/identity.json>` — JSON ファイルからアイデンティティを適用（Path B）
  - エージェントが直接 `customer/{slug}/` を優先し、未設定時のみ `knowledge/personal/` 配下のスキーマ準拠ファイルを書き込み
  - `KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1 pnpm onboard` — 意図的に default 値で進める（評価環境向け）
- **物理的変化**:
  - `customer/{slug}/my-identity.json` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/my-identity.json` になります。
  - `customer/{slug}/my-vision.md` が生成（または更新）されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/my-vision.md` になります。
  - `customer/{slug}/onboarding/onboarding-state.json` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/onboarding/onboarding-state.json` になります。
  - `customer/{slug}/onboarding/onboarding-summary.md` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/onboarding/onboarding-summary.md` になります。

### Stage 5: 邂逅と命名の儀式 (Greeting & Naming)
- **内容**: アイデンティティ設定の最後に、エージェントが自ら自己紹介を行い、主権者との間で「Agent ID」を合意します。
- **目的**: A2A 通信やブロックチェーン記録に使用する、エージェントの公的な名前（Agent ID）を決定します。
- **物理的変化**:
  - `customer/{slug}/agent-identity.json` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/agent-identity.json` になります。

### Stage 6: 接続・領域・チュートリアルの下準備
- **内容**: サービス接続の候補、テナント 1 件分の登録、最初の tutorial plan を個別に整えます。
- **目的**: 初回実行で副作用を強制せず、提案・承認・適用を分離します。
- **物理的変化**:
  - `customer/{slug}/connections/*.json` が候補として生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/connections/*.json` になります。
  - `customer/{slug}/tenants/*.json` が 1 件ずつ生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/tenants/*.json` になります。
  - `customer/{slug}/onboarding/tutorial-plan.md` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/onboarding/tutorial-plan.md` になります。

---

## 🩺 健全性確認 (Vital Check)

オンボーディングが正しく完了したかを確認するには、以下のコマンドを実行してください。

```bash
pnpm vital
```

**期待される出力例**:
- ✅ [OK] Physical Foundation (node_modules)
- ✅ [OK] System Build (dist)
- ✅ [OK] Sovereign Identity
- ✅ [OK] Sovereign Vision
- ✅ [OK] Onboarding Summary

---
*Status: Mandated by AGENTS.md*
*Last Updated: 2026-05-06 by Ecosystem Architect*
