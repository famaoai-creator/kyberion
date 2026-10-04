---
title: Browser Discovery & Inspection Playbook
category: Orchestration
tags: [orchestration, browser, discovery, inspection, adf, playbook]
importance: 9
author: Kyberion Engineering
last_updated: 2026-10-04
---

# Browser Discovery & Inspection Playbook

When automating web interactions in Kyberion, **never jump straight to writing a complex ADF (Action Definition Format) pipeline blindly.**
Follow this progressive disclosure ladder: **Inspect First → Analyze DOM → Crystallize into ADF**.

---

運用上の成功条件・一意な対象・承認・結果不明時の再確認・再開記録は
[Browser Automation Operating Checklist](./browser-automation-best-practices.md) を正本とする。
Inspect の出力はその時点の観測であり、後の操作対象や成功を保証しない。

## 1. The Two-Phase Workflow

```
[Phase 1: Discovery (軽量調査)]
  1コマンドで DOM / フォーム / ボタン / リンク を直接ダンプ
  ↓
  対象サイトの構造・セレクタ・認証・Bot検知（WAF）の有無を特定

[Phase 2: Crystallization (パイプライン固定化)]
  特定されたセレクタと確定手順をもとに ADF を作成
  ↓
  `pnpm kyberion browser run --adf <file>` で安全・再現可能に自動実行
```

---

## 2. Discovery ツールと使い分け

状況やエージェント環境に応じて、最もオーバーヘッドの少ない手段を選択します。

| 手法                        | 用途                                   | 実行コマンド / ツール                                              | 特徴                                                                                                      |
| :-------------------------- | :------------------------------------- | :----------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| **Fast Static Fetch**       | 静的ページ、初期HTMLの把握             | `pnpm kyberion browser inspect <url> --mode fetch`                 | ヘッドレスブラウザ不使用。数十ミリ秒でフォーム・リンク・見出しをダンプ                                    |
| **Dynamic Browser Inspect** | SPA、動的レンダリングページの調査      | `pnpm kyberion browser inspect <url>`                              | Playwright（Chromium）を起動し、DOM Hydration 後の入力欄・ボタンを解析                                    |
| **CDP Mode (Attach)**       | 既存の起動中Chromeを遠隔操作して調査   | `pnpm kyberion browser inspect [url] --mode cdp [--cdp-port 9222]` | `--remote-debugging-port` で起動された通常Chromeにアタッチして解析                                        |
| **Chrome Extension Mode**   | 許可された通常ブラウザ上での調査 | `pnpm kyberion browser inspect --mode extension`                   | ユーザーの通常ブラウザ・実セッション上で動作する拡張機能(Sidepanel)から1クリックでDOM構造を安全に吸い上げ |

---

## 3. `kyberion browser inspect` コマンドの使い方

### 基本構文

```bash
pnpm kyberion browser inspect [url] [options]
```

### 主なオプション

- `--mode <browser|fetch|cdp|extension>`:
  - `browser` (デフォルト): Playwright を起動して動的 DOM を解析
  - `fetch`: HTTP リクエストのみで静的 HTML を高速解析（Node fetch）
  - `cdp`: 既存の Chrome (`--remote-debugging-port=9222`) にアタッチして解析
  - `extension`: 拡張機能（Kyberion Browser Bridge）からのプッシュ受信待ち受け（127.0.0.1:8788）
- `--cdp-port <number>`: CDP 接続ポート（デフォルト 9222）
- `--cdp-url <string>`: 明示的な CDP エンドポイント URL
- `--extension-port <number>`: 拡張機能プッシュ受け取りポート（デフォルト 8788）
- `--wait <ms>`: Inspect の観測前の固定待機時間（ミリ秒、デフォルト 2500）。ページの準備完了や操作成功を保証する条件待機ではない
- `--headed`: 実際のブラウザウィンドウを表示して視覚確認（browser モード）
- `--screenshot <path>`: 解析時にスクリーンショットを保存
- `--json`: 他のスクリプトやパイプ（`| jq`）と連携可能な純粋な JSON を出力

### 出力される情報

1. **ページタイトル・最終URL**（リダイレクト追跡後）
2. **Form Controls & Inputs**: `input`, `select`, `textarea` の `name`, `id`, `placeholder`, `label`, `required`
3. **Action Buttons**: クリック可能なボタン（`button`, `[role="button"]`, submit）のテキストと識別子
4. **Headings**: `h1`〜`h3` の見出し階層
5. **Key Links**: ページ内の主要アンカーリンク一覧
6. **Text Preview**: 本文のテキスト抜粋

---

## 4. Phase 2: ADF パイプラインへの昇格（Promotion）

Phase 1 で特定した情報をもとに、正規オペレータ形の ADF を作成します。
旧形 (`capture:goto` / `apply:fill` / `apply:click`) は使わないでください。
正規形は `control:browser:open_tab` → `capture:browser:snapshot` →
`apply:browser:click|fill|press|wait (selector + role/name)` →
`apply:code:write_artifact` です（詳細は [ADF Pipeline Learning Playbook §8](./adf-pipeline-learning-playbook.md)）。

以下は読み取り専用検索を想定した構造例。URL と selector は例示なので、実際に観測した一意な対象に置き換え、
入力の送信先・権限を確認してから preflight する。最後の snapshot を成功条件と比較するのは実行者の責任である。

```json
{
  "action": "pipeline",
  "pipeline_id": "readonly-search",
  "session_id": "readonly-search",
  "options": {
    "headless": true
  },
  "steps": [
    {
      "id": "open",
      "type": "control",
      "op": "browser:open_tab",
      "params": {
        "url": "https://example.com/search",
        "select": true,
        "waitUntil": "domcontentloaded"
      }
    },
    {
      "id": "snap",
      "type": "capture",
      "op": "browser:snapshot",
      "params": { "export_as": "page_snapshot" }
    },
    {
      "id": "fill-query",
      "type": "apply",
      "op": "browser:fill",
      "params": { "selector": "#search-input", "text": "demo", "name": "Search", "role": "textbox" }
    },
    {
      "id": "submit",
      "type": "apply",
      "op": "browser:click",
      "params": { "selector": "button[type='submit']", "name": "Search", "role": "button", "max_retries": 0 }
    },
    {
      "id": "wait-results",
      "type": "apply",
      "op": "browser:wait",
      "params": { "selector": "#search-results", "state": "visible", "timeout": 10000, "max_retries": 0 }
    },
    {
      "id": "verify-results",
      "type": "capture",
      "op": "browser:snapshot",
      "params": { "export_as": "result_snapshot" }
    },
    {
      "id": "evidence",
      "type": "capture",
      "op": "browser:screenshot",
      "params": { "path": "active/shared/tmp/receipt.png" }
    }
  ]
}
```

ルール:

- `open_tab` と `snapshot` は同一セッションで実行する。`session_id` をトップレベルに固定し、ステップ間で変えない。
- 手書きADFでは `browser:` 接頭辞の正規形（`browser:open_tab` 等）を使う。`trail→export_adf` が出す短形（`goto`/`click` 等）はランタイムが同一正規opへ正規化するエイリアスであり、手書きとエクスポートの差ではない（`normalizeBrowserPipelineOp` 参照）。
- `snapshot` 直後に URL が `about:blank` でないことを確認する（`adf-pipeline-learning-playbook.md §2 Step 6` の smoke 条件）。
- `click/fill/press` には `selector` に加え、判明した `role` / `name` を付け、直近の観測で意図した対象が一意であることを確認する（`@eN` のみは再実行できない）。`wait` は必要な状態を表す selector/state と上限を指定する。
- secret 入力は `browser:fill_secret_ref` + `dom_path` + `secret_ref` を使い、承認ゲートを迂回しない。
- 一時的な非機密の検証は `active/shared/tmp/` 内で実施。機密・個人の証跡は mission の tier/tenant に従う。
- timeout や切断後は正本の結果不明時の手順へ戻る。検索結果の表示や screenshot の存在だけで、要求された結果が得られたと断定しない。
- 恒常的な業務フローとして再利用する場合は `pipelines/` ディレクトリへ昇格（`pnpm pipeline:promote`）させます。ただしブラウザ録画 (`browser-recording.v1`) 由来のドラフトは `--adf` に渡さないこと（承認迂回防止）。録画の昇格は `promote-procedure` 経由（→ [新規サイト学習 Playbook](./browser-site-learning-playbook.md) §4-§6）。

---

## 5. Browser Profile Management（プロファイル管理と連携）

Chrome や Playwright の複数プロファイルを検出し、特定のプロファイルコンテキストでブラウザを起動・操作できます。

### プロファイル一覧の確認

```bash
pnpm kyberion browser profiles [--provider chrome|playwright|all] [--json]
```

- **Chrome**: `Local State` から表示名、アカウント、ディレクトリ、および現在の起動状態（`ACTIVE` / `IDLE`）を検出。
- **Playwright**: `active/shared/browser_profiles/` 配下の分離ストレージセッションを検出。

### 特定プロファイルでの URL オープン

```bash
# プロファイル名（表示名）やメールアドレスで指定して開く
pnpm kyberion browser open "https://example.com" --profile "Ichimura"

# Playwright の独立プロファイルで開く
pnpm kyberion browser open "https://example.com" --provider playwright --profile "agent-session"
```

### ADF パイプラインでのプロファイル指定

ADF の `options` に `profile`, `profile_name`, または `profile_email` を指定することで、対象プロファイルの `user_data_dir` と `profile_directory` が自動解決されます：

```json
{
  "action": "pipeline",
  "pipeline_id": "authenticated-job",
  "session_id": "authenticated-job",
  "options": {
    "browser_channel": "chrome",
    "profile": "Ichimura"
  },
  "steps": [
    {
      "id": "profiles",
      "type": "apply",
      "op": "browser:list_profiles",
      "params": { "export_as": "available_profiles" }
    },
    {
      "id": "open",
      "type": "control",
      "op": "browser:open_tab",
      "params": { "url": "https://service.example.com", "select": true }
    }
  ]
}
```

## Extending profile providers

Browser profile discovery and opening share the schema-backed `browser-profile-providers.json` registry. A provider module exports `browserProfileProvider` with `listProfiles(options)` and `openProfile(profile, url, print)`. Add the module package and one registry entry; the CLI and browser pipeline consume the same provider contract without provider-specific branches. Keep provider IDs stable and return profiles whose `provider` exactly matches the registry ID. Optional compiled fallback paths must remain repository-relative regular files.
