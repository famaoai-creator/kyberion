# 🚀 Kyberion Ecosystem: Onboarding & Initialization Guide

この文書は、Kyberion エコシステムの物理的起動と、主権者（Sovereign）としてのアイデンティティ確立（オンボーディング）の完全なプロセスを定義します。

> **この文書がコールドスタート手順の唯一の正本です。** README / QUICKSTART / AGENTS.md は要約とここへのリンクのみを持ち、手順が食い違う場合は本書を正とします。

## 📋 クイック・スタート (Quick Commands)

システムをゼロから立ち上げるための標準的なコマンド列です。

最短経路だけ先に知りたい場合は、次の 1 本から始められます。

```bash
pnpm install && pnpm prereq:check && pnpm build && pnpm setup:report --persona first-time-user
```

前提:

- Node.js `24+`（`package.json` の `engines` が正。`.nvmrc` も `24`。`nvm use` で揃えられます）
- `pnpm`

```bash
# 1. 物理的基盤の確立 (依存関係のインストール)
pnpm install

# 2. 事前ツール確認 (Node 24+ floor / pnpm / git / Playwright ブラウザ有無 などを一括チェック)
pnpm prereq:check

# 2b. (推奨) ブラウザ first-win 用の Playwright ブラウザ導入
#     未導入でも起動はできますが、ブラウザ経路(スクリーンショット first-win 等)は
#     テキストへフォールバックします。postinstall では自動ダウンロードしません。
pnpm exec playwright install chromium

# 2c. (必要時のみ) アクチュエータ単位の on-demand pull
#     browser / voice / media-generation のように、起動前に個別依存だけ確認したい場合に使います。
pnpm deps:check --actuator browser
pnpm deps:check --actuator voice
pnpm deps:check --actuator media-generation

# 3. システムの具現化 (ビルド)
pnpm build

# 4. バックグラウンド surface の認証準備を確認
pnpm surfaces:setup

# 5. 外部サービス連携の認証準備を確認
pnpm services:setup

# 6. reasoning backend の準備を確認
pnpm reasoning:setup

# 7. 一括 readiness レポートを確認
pnpm setup:report

# 8. バックグラウンド surface の整列
pnpm surfaces:reconcile

# 9. 魂の注入 (オンボーディング)
pnpm onboard

`pnpm onboard` は `dist/` が必要です。`pnpm build` を先に実行してから起動してください。
```

---

## 🔍 詳細プロセスと物理的効果 (Detailed Process)

### Stage 1: 物理的基盤の確立 (Physical Foundation)

- **実行コマンド**: `pnpm install`
- **目的**: 必要なライブラリを全てロードし、内部モジュール間の接続を確立します。
- **物理的変化**:
  - `node_modules/` が生成されます。
  - ワークスペース間のシンボリックリンク（`@agent/core` など）が構築されます。

### Stage 2: 事前ツール確認 (Prerequisite Toolchain Check)

- **実行コマンド**: `pnpm prereq:check`
- **目的**: Node / pnpm / git / TypeScript / tsx / vitest など、Kyberion をソースから動かすための基本ツールが揃っているかを確認します。
- **チェック内容の補足**:
  - **Node floor 検証**: 実行中の Node が `package.json` の `engines`（`>=24.0.0`）を満たすかを実バージョン比較で検証し、不足なら `nvm install 24 && nvm use 24` を案内して失敗します（バイナリ存在確認だけの素通りはしません）。
  - **Playwright ブラウザ有無**: ブラウザキャッシュ（`ms-playwright`）が見つからない場合、**非致命の警告**として `pnpm exec playwright install chromium` を案内します。ブラウザ first-win を使うなら導入してください。
- **物理的変化**:
  - まだ実体の変更は行いません。足りないツールやローカル依存が要約されます。

### Stage 3: システムの具現化 (System Manifestation)

- **実行コマンド**: `pnpm build`
- **目的**: 依存関係をコンパイルし、実行可能なバイナリ（JavaScript）を生成します。
- **物理的変化**:
  - `dist/` ディレクトリが生成され、全ソースコードがビルドされます。
  - `presence/displays/chronos-mirror-v2/.next/` が生成されます（`build:ui` step）。
  - workspace 間の runtime contract が再構築されます。
- **ステップ構成**: `build:packages` → `build:actuators` → `build:repo` → `build:ui`。
  個別実行する場合は `pnpm build:ui` のみで Chronos UI を再ビルドできます。

### Python Runtime Resolution

- Python 系の bridge は、原則として `KYBERION_PYTHON_BIN` → `KYBERION_PYTHON` → managed runtime (`active/shared/runtime/tool-runtimes/*/bin/python`) → `.venv/bin/python3` → `python3` の順で解決されます。
- `.venv/bin/python3` は legacy compatibility 用の repo-local 実行環境候補であり、新規標準ではありません。
- 音声サンプルやプロモート後の voice profile データは `active/shared/tmp/` または `active/shared/runtime/voice-profiles/<profile_id>/` に置きます。

### Stage 4: Runtime Surface Setup

- **実行コマンド**: `pnpm surfaces:setup`
- **目的**: `slack-bridge`、`imessage-bridge`、`discord-bridge`、`telegram-bridge`、`chronos-mirror-v2`、`nexus-daemon`、`terminal-bridge` などの background surface について、認証の不足項目、CLI 代替、ホスト管理 surface を確認します。
- **物理的変化**:
  - 認証と起動準備の要約が表示されます。
- **補助コマンド**:
  - `pnpm surfaces:reconcile` で setup 結果をもとに background surface を標準起動します。
  - `pnpm surfaces:status` で起動状態を確認できます。
  - `pnpm surfaces:repair -- --surface <surface-id>` で stale / unhealthy な surface を再起動できます。
  - `pnpm surfaces:start -- --surface <surface-id>` で個別 surface を開始できます。
  - `pnpm surfaces:stop -- --surface <surface-id>` で個別 surface を停止できます。

### Stage 5: External Service Setup

- **実行コマンド**: `pnpm services:setup`
- **目的**: GitHub、Google Workspace、Slack、Notion、Jira などの service preset について、必要な secret、CLI 代替、customer/personal connection の置き場を先に確認します。
- **物理的変化**:
  - まだ実体の変更は行いません。設定不足の候補だけが要約されます。

### Service Preflight

- **実行コマンド**: `pnpm service:preflight -- --service <service-id>`
- **目的**: 実行直前に、特定の service が今使えるかを確認します。`services:setup` が「準備」、`service:preflight` が「実行可否」です。
- **使いどころ**:
  - `voice` / `meeting` のように bridge health を持つもの
  - `media-generation` のように local runtime に依存するもの
  - `google-workspace` のように auth と CLI health を合わせて見たいもの
- **補足**:
  - `pnpm services:setup` が未完でも `service:preflight` は実行できますが、auth が不足していれば失敗します。

### Stage 6: Reasoning Backend Setup

- **実行コマンド**: `pnpm reasoning:setup`
- **目的**: `claude-cli` / `gemini-cli` / `codex-cli` / `anthropic` / `nemotron-api` / `local` / `stub` のどれが現在の host で使えるかを確認し、`env:bootstrap` に進む前の判断材料を出します。
- **物理的変化**:
  - まだ実体の変更は行いません。利用可能な backend と不足条件が見えるだけです。

### Stage 7: Consolidated Readiness Report

- **実行コマンド**: `pnpm setup:report`
- **目的**: `surface` / `service` / `reasoning` / `doctor` の readiness を一度に確認し、初期セットアップの抜けをまとめて潰します。
- **物理的変化**:
  - まだ実体の変更は行いません。まとめた readiness summary が表示されます。

### Media Runtime Preflight

- **実行コマンド**: `pnpm service:preflight -- --service media-generation`
- **補助コマンド**: `pnpm media:preflight`
- **目的**: `media-generation` 系の実装や MV パイプラインを開始する前に、ローカルの ComfyUI サービス runtime が試行可能かを確認します。
- **使いどころ**:
  - `pnpm service:preflight -- --service media-generation` が通るなら、`media-generation` の runtime 側前提は少なくとも到達可能です。
  - `pnpm media:preflight` は同じ runtime の簡易確認として使えます。
  - 失敗した場合は `pnpm services:setup` とあわせて、ComfyUI の起動・プロビジョニング・接続先の確認を進めます。

### Stage 8: Runtime Surface Reconciliation

- **実行コマンド**: `pnpm surfaces:reconcile`
- **目的**: setup で確認した状態をもとに、background surface を manifest から標準起動します。
- **物理的変化**:
  - `active/shared/runtime/surfaces/state.json` が生成または更新されます。
  - `active/shared/logs/surfaces/` に surface ごとのログが出力されます。
  - `runtime-supervisor` に surface runtime が登録されます。

### Stage 9: 魂の注入 (Soul Infusion)

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

### Stage 10: 邂逅と命名の儀式 (Greeting & Naming)

- **内容**: アイデンティティ設定の最後に、エージェントが自ら自己紹介を行い、主権者との間で「Agent ID」を合意します。
- **目的**: A2A 通信やブロックチェーン記録に使用する、エージェントの公的な名前（Agent ID）を決定します。
- **物理的変化**:
  - `customer/{slug}/agent-identity.json` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/agent-identity.json` になります。

### Stage 11: 接続・領域・チュートリアルの下準備

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

_Status: Mandated by AGENTS.md — canonical cold-start source (ONB-02)_
_Last Updated: 2026-07-05_
