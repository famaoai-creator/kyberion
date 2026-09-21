# 🚀 Kyberion Ecosystem: Onboarding & Initialization Guide

この文書は、first-win 後の Day-2 初期化で使うコマンドの詳しい説明と、環境ごとの注意をまとめたものです。

- first-win の正本は [QUICKSTART.md](./QUICKSTART.md) です。
- **手順の順序とルート分岐（個人のみ / AI 会社 / 既存テナント追加）の正本は [オンボーディング標準フロー](../knowledge/product/governance/onboarding-flow.md) です。** 迷ったらまずそちらを見てください。
- 文書カテゴリごとの正本と補足資料の対応は [documentation-source-map.json](./documentation-source-map.json) にあります。

## 📋 クイック・スタート (Quick Commands)

first-win をまだ実行していない場合は、先に QUICKSTART.md の 5 コマンドを完了してください。

# kyberion-first-win

```bash
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm doctor
pnpm pipeline --input pipelines/verify-session.json
```

Kyberion の readiness check は `pnpm run doctor` です。`pnpm build` の後なら、上の `pnpm doctor` はリポジトリのスクリプトを実行します。`run` を付けない素の `pnpm doctor` は、ビルド前の文脈では pnpm 自身の診断になります。

first-win の後は、標準フローの順に次を進めます。

```bash
# readiness を一括確認（標準フロー Step 2）
pnpm kyberion setup report --persona first-time-user
pnpm surfaces reconcile

# stance を決めてから identity を保存（Step 3）
pnpm customer:switch <customer-slug>   # 顧客・会社として使う場合のみ
pnpm onboard

# baseline を all_clear にする（Step 4）
pnpm pipeline --input pipelines/baseline-check.json
```

個人のみのルートはここで完了確認（下の「健全性確認」）に進みます。tenant を扱う場合は標準フローの Step 5〜8 に進んでください。

## 前提

- Node.js `24+`（`package.json` の `engines` が正。`.nvmrc` も `24`。`nvm use` で揃えられます）
- `pnpm`
- `git`

Windows では、PowerShell から winget で基盤ツールを導入できます。

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id pnpm.pnpm --exact --source winget --accept-source-agreements --accept-package-agreements
winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements
```

Windows でローカル AI 支援（Foundry Local）を使う場合は、追加で次を実行します。これは任意機能です。

```powershell
winget install --id Microsoft.FoundryLocal --exact --source winget --accept-source-agreements --accept-package-agreements
```

導入後は Foundry Local のローカル API を起動し、必要に応じて `KYBERION_WINDOWS_AI_ENDPOINT` と `KYBERION_WINDOWS_AI_MODEL` を設定してください。

導入後に PowerShell を開き直し、通常の手順を続けてください。既存の governed manifest を使う場合は、次のコマンドで不足を確認し、承認付きで適用できます。

```powershell
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm env:bootstrap --manifest kyberion-toolchain --apply --force
```

---

## 🔍 詳細プロセスと物理的効果 (Detailed Process)

各 Stage と標準フローの Step の対応は次のとおりです。

| Stage | 内容                             | 標準フロー |
| ----- | -------------------------------- | ---------- |
| 1〜3  | 導入、ビルド、事前ツール確認     | Step 1     |
| 4〜5  | readiness と surface の起動      | Step 2     |
| 6〜7  | stance の選択と identity の保存  | Step 3     |
| 8     | baseline を all_clear にする     | Step 4     |
| 9     | tenant、organization、activation | Step 5〜8  |

### Stage 1: 物理的基盤の確立 (Physical Foundation)

- **実行コマンド**: `pnpm install`
- **目的**: 必要なライブラリを全てロードし、内部モジュール間の接続を確立します。
- **物理的変化**:
  - `node_modules/` が生成されます。
  - ワークスペース間のシンボリックリンク（`@agent/core` など）が構築されます。

### Stage 2: システムの具現化 (System Manifestation)

- **実行コマンド**: `pnpm build`
- **目的**: 依存関係をコンパイルし、実行可能な JavaScript を生成します。`env:bootstrap`、`doctor`、`onboard` の一部など、後続コマンドの多くが `dist/` を使うため、この Stage を先に済ませます。
- **物理的変化**:
  - `dist/` ディレクトリが生成されます。
  - Chronos（`presence/displays/chronos-mirror-v2/.next/`）と concierge の UI がビルドされます（`build:ui`）。
  - workspace 間の runtime contract が再構築されます。
- **ステップ構成**: `build:packages` → `build:actuators` → terminal-hud → `build:repo` → `build:ui`。
  UI だけを作り直す場合は `pnpm build:ui` を使います。

### Stage 3: 事前ツール確認 (Prerequisite Toolchain Check)

- **実行コマンド**: `pnpm env:bootstrap --manifest kyberion-toolchain`
- **目的**: Node / pnpm / git / TypeScript / tsx / vitest など、Kyberion をソースから動かすための基本ツールが揃っているかを確認します。
- **チェック内容の補足**:
  - **Node floor 検証**: 実行中の Node が `package.json` の `engines`（`>=24.0.0`）を満たすかを実バージョン比較で検証し、不足なら `nvm install 24 && nvm use 24` を案内して失敗します。
  - **Playwright ブラウザ有無**: ブラウザキャッシュ（`ms-playwright`）が見つからない場合、**非致命の警告**として `pnpm exec playwright install chromium` を案内します。ブラウザ first-win を使うなら導入してください。postinstall では自動ダウンロードしません。
- **物理的変化**:
  - 実体の変更は行いません。足りないツールやローカル依存が要約されます。

### Python Runtime Resolution

- Python 系の bridge は、原則として `KYBERION_PYTHON_BIN` → `KYBERION_PYTHON` → managed runtime (`active/shared/runtime/tool-runtimes/*/bin/python`) → `.venv/bin/python3` → `python3` の順で解決されます。
- `.venv/bin/python3` は legacy compatibility 用の repo-local 実行環境候補であり、新規標準ではありません。
- AGY native subagent を使う場合は、公式 SDK を managed runtime へ `pnpm agy:sdk:setup --apply`（内部では `uv venv` + `uv pip install`）で導入できます。Python 3.10+ が必要で、任意の Python 実行ファイルは `KYBERION_AGY_SDK_PYTHON` で上書きできます。
- AGY CLI の Kyberion 用カスタムエージェント定義は `pnpm agents:generate` で `.agents/agents/` に生成されます。手動で一覧を確認する場合は `agy --add-dir "$PWD" agent`、特定の定義を選ぶ場合は `agy --add-dir "$PWD" --agent kyberion-implementer ...` を使います。`AgyCliBackend` はワークスペースを自動的に `--add-dir` へ渡します。
- 音声サンプルやプロモート後の voice profile データは `active/shared/tmp/` または `active/shared/runtime/voice-profiles/<profile_id>/` に置きます。

### Stage 4: Readiness の確認

- **実行コマンド**: `pnpm kyberion setup report --persona first-time-user`
- **目的**: surface / service / reasoning / doctor の readiness を一度に確認し、初期セットアップの抜けをまとめて見つけます。まずこれを実行し、報告に出た項目だけを下の個別コマンドで詳しく見てください。
- **物理的変化**: 実体の変更は行いません。

#### 4a. Runtime Surface Setup

- **実行コマンド**: `pnpm surfaces setup`
- **目的**: `concierge`、`presence-studio`、`chronos-mirror-v2`、`voice-hub`、`slack-bridge`、`imessage-bridge`、`discord-bridge`、`telegram-bridge`、`nexus-daemon`、`terminal-bridge` などの background surface について、認証の不足項目、CLI 代替、ホスト管理 surface を確認します。
- **補助コマンド**:
  - `pnpm surfaces status` で起動状態を確認できます。
  - `pnpm surfaces repair -- --surface <surface-id>` で stale / unhealthy な surface を再起動できます。
  - `pnpm surfaces start -- --surface <surface-id>` / `pnpm surfaces stop -- --surface <surface-id>` で個別に開始・停止できます。

#### 4b. External Service Setup と Preflight

- **実行コマンド**: `pnpm services:setup`
- **目的**: GitHub、Google Workspace、Slack、Notion、Jira などの service preset について、必要な secret、CLI 代替、customer/personal connection の置き場を先に確認します。実体の変更は行いません。
- **実行直前の確認**: `pnpm service:preflight -- --service <service-id>`。`services:setup` が「準備」、`service:preflight` が「いま使えるか」です。auth が不足していれば失敗します。
  - `voice` / `meeting` のように bridge health を持つもの
  - `google-workspace` のように auth と CLI health を合わせて見たいもの
  - `media-generation` のようにローカル runtime に依存するもの。ComfyUI などの runtime に到達できるかを確かめる入口です。失敗した場合は ComfyUI の起動、プロビジョニング、接続先を確認してください。

#### 4c. Reasoning Backend Setup

- **実行コマンド**: `pnpm reasoning:setup`
- **目的**: 現在の host で使える reasoning backend を確認します。候補は `knowledge/product/governance/reasoning-backend-policy.json` の `allowed_modes` が正本で、主に次のものがあります。
  - ローカル CLI: `claude-cli` / `codex-cli` / `gemini-cli` / `agy-cli` / `grok-cli` / `copilot` / `cursor-cli` / `opencode-cli`
  - API: `anthropic` / `claude-agent` / `gemini-api` / `grok-api` / `openrouter` / `nemotron-api`
  - ローカルモデル: `local` / `ollama` / `vllm` / `lmstudio` / `llamacpp` / `mlx` / `localai`
  - オフライン・テスト用: `stub`
- **物理的変化**:
  - 対話モードで backend を選択した場合のみ、`.env.local` に `KYBERION_REASONING_BACKEND` が保存されます。
- **既知の落とし穴（claude-cli のシャドウイング）**: repo 依存の `@anthropic-ai/claude-code` は postinstall 未承認のあいだ `node_modules/.bin/claude` に placeholder shim を置き、pnpm 環境ではこれが PATH 上で本物の `claude`（例: `~/.local/bin/claude`）を隠します。`claude` 実行時に `claude native binary not installed` と表示されたらこの状態です。対処: `pnpm approve-builds` で `@anthropic-ai/claude-code` を承認するか、`KYBERION_CLAUDE_CLI_BIN=$HOME/.local/bin/claude` を設定してください（probe は placeholder 検出時に `~/.local/bin` / `/opt/homebrew/bin` / `/usr/local/bin` などへ自動フォールバックしますが、明示設定が最も確実です）。

#### 4d. 機能ごとの依存と system tool

- **actuator 単位の依存**: `pnpm deps:check --actuator browser|voice|media-generation`。その機能を使う前に個別の依存だけを確認します。
- **system tool**: `pnpm tool:setup -- --list` で一覧を確認し、`pnpm tool:setup -- --tool <tool> --apply` で導入します。lightpanda のように `managed_binary` を宣言した tool は、チェックサム固定の upstream release を managed env に入れます。

### Stage 5: Runtime Surface Reconciliation

- **実行コマンド**: `pnpm surfaces reconcile`
- **目的**: setup で確認した状態をもとに、background surface を manifest から標準起動します。concierge（秘書室、`http://127.0.0.1:3050`）もここで起動し、Stage 7 の GUI 経路が使えるようになります。
- **物理的変化**:
  - `active/shared/runtime/surfaces/state.json` が生成または更新されます。
  - `active/shared/logs/surfaces/` に surface ごとのログが出力されます。
  - `runtime-supervisor` に surface runtime が登録されます。

### Stage 6: stance の選択

identity の保存先と、baseline-check の L3 が確認する場所は、アクティブな stance で決まります。**identity を保存する前に**決めてください。

- 自分として使う: `KYBERION_CUSTOMER` を設定しません。保存先は `knowledge/personal/` です。
- 顧客・会社として使う: `pnpm customer:switch <customer-slug>` で切り替えます（overlay がなければ `pnpm customer:create <customer-slug>`）。保存先は `customer/{slug}/` です。

### Stage 7: 魂の注入 (Soul Infusion)

- **実行コマンド**: `pnpm onboard`（`dist/` が必要です）
- **目的**: 主権者の名前、言語、対話スタイル、専門分野、vision をシステムに記憶させます。
- **GUI で行う場合**: concierge の `/settings` を開きます（旧 `/setup` と `/onboarding` はここへリダイレクトされます）。「あなたのこと」で identity を保存し、「組織とメンバー」でメンバーと承認者を登録します。承認者は後の tenant activation で `--owner-id` に指定します。
- **非対話環境の場合**: TTY が無い環境では `pnpm onboard` は exit 2 で停止します。代わりに以下のいずれかを使用します。
  - `pnpm onboard apply --identity <path/to/identity.json>` — JSON ファイルからアイデンティティを適用（Path B）
    - ひな形は [`knowledge/public/templates/onboarding/identity.example.json`](../knowledge/public/templates/onboarding/identity.example.json) をコピーして使ってください。まず `--dry-run` で検証すると安全です。
  - `KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1 pnpm onboard` — 意図的に default 値で進める（評価環境向け）
- **やり直す場合**: `pnpm onboard reset` で onboarding state と生成された identity / vision / agent の成果物を削除します。
- **物理的変化**:
  - `customer/{slug}/my-identity.json` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/my-identity.json` になります。
  - `customer/{slug}/my-vision.md` が生成（または更新）されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/my-vision.md` になります。
  - `customer/{slug}/onboarding/onboarding-state.json` と `onboarding-summary.md` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/onboarding/` 配下になります。
  - アイデンティティ設定の最後に、エージェントが自己紹介を行い、主権者との間で Agent ID（A2A 通信や記録に使う公的な名前）を合意します。`customer/{slug}/agent-identity.json` が生成されます。`KYBERION_CUSTOMER` 未設定時は `knowledge/personal/agent-identity.json` になります。
  - サービス接続の候補（`connections/*.json`）、tenant 候補、最初の tutorial plan（`onboarding/tutorial-plan.md`）が同じ profile 配下に生成されます。これらは候補であり、外部への副作用は起きません。

### Stage 8: baseline を all_clear にする

- **実行コマンド**: `pnpm pipeline --input pipelines/baseline-check.json`
- **目的**: 判定層 L0〜L11 がすべて通ることを確認します。層の一覧は標準フローの Step 0 にあります。
- **初回に落ちやすい層**:
  - **L8（storage janitor）**: baseline-check が janitor を自動で投入します。完了後に再実行すれば通ります。手動で走らせる場合は `pnpm pipeline --input pipelines/storage-janitor.json --context '{"dry_run":false}'` を使います。
  - **L10（scheduler）**: 有効なスケジュールがなければ通ります。スケジュールを登録したら chronos daemon を常駐させます。macOS では `pnpm kyberion chronos install` で内容を確認し、`--apply` で LaunchAgent に登録します。その場で動かすだけなら `pnpm chronos` です。
  - **L11（監査台帳）**: 監査記録が一つもないか古いと落ちます。Stage 7 などの governed 操作で記録されます。

### Stage 9: tenant・organization・activation（必要な場合のみ）

個人のみで使う場合、この Stage は不要です。tenant を扱う場合は、[標準フロー](../knowledge/product/governance/onboarding-flow.md) の Step 5〜8 を順に実行してください。ここでは、そこで結び付ける 3 つの別物を整理しておきます。

| 何を指すか                             | 役割                                                           | 置き場                                          |
| -------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| **customer-slug**（stance / 運用主体） | 「いま自分はどの主体として振る舞っているか」— **実行時の設定** | `customer/{slug}/` + `KYBERION_CUSTOMER`        |
| **tenant-slug**（テナント）            | 「いまどの機密境界の内側にいるか」— **データ境界**             | `knowledge/confidential/{tenant-slug}/`         |
| **organization-id**（組織）            | 「そのテナントをどう運営しているか」— テナント配下の運用モデル | `active/organizations/{tier}/{tenant}/{org_id}` |

`customer-slug` と `tenant-slug` は同じ綴りになることが多いですが同一物ではありません（前者は設定、後者は境界）。包含順の正本は [entity-scope-hierarchy](../knowledge/product/architecture/entity-scope-hierarchy.md)、3 層の区別は [stance-tenant-customer-model](../knowledge/product/architecture/stance-tenant-customer-model.md) を参照してください。テナント自身の顧客は `knowledge/confidential/{tenant-slug}/customers/` に置き、`customer/{slug}/` には置きません。

AI 会社として始める場合は、`pnpm onboard company --vertical <vertical> --slug <company-slug> --name "<会社名>" --owner-id human:<owner> --goal "<最初の成果>" --tenant-slug <tenant-slug> --dry-run` で tenant 登録と context binding をまとめて確認できます。AI worker は作業を準備・実行できますが、契約、支払、外部公開、権限変更などの最終判断は `--owner-id` の人間が保持します。会社オンボーディングは activation を自動完了しません。

---

## 🩺 健全性確認 (Vital Check)

オンボーディングが正しく完了したかを確認するには、以下のコマンドを実行してください。

```bash
pnpm pipeline vital-check
pnpm pipeline --input pipelines/baseline-check.json
```

**期待される出力例**:

- ✅ [OK] Physical Foundation (node_modules)
- ✅ [OK] System Build (dist)
- ✅ [OK] Sovereign Identity
- ✅ [OK] Sovereign Vision
- ✅ [OK] Onboarding Summary

baseline-check の `status` が `all_clear` であれば完了です。

---

_Status: Mandated by AGENTS.md — day-2 command reference (ONB-02)_
_Last Updated: 2026-09-22_
