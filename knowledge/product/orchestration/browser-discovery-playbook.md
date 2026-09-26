---
title: Browser Discovery & Inspection Playbook
category: Orchestration
tags: [orchestration, browser, discovery, inspection, adf, playbook]
importance: 9
author: Kyberion Engineering
last_updated: 2026-09-27
---

# Browser Discovery & Inspection Playbook

When automating web interactions in Kyberion, **never jump straight to writing a complex ADF (Action Definition Format) pipeline blindly.**
Follow this progressive disclosure ladder: **Inspect First → Analyze DOM → Crystallize into ADF**.

---

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
| **Chrome Extension Mode**   | 厳格なBot対策(Akamai/Cloudflare等)回避 | `pnpm kyberion browser inspect --mode extension`                   | ユーザーの通常ブラウザ・実セッション上で動作する拡張機能(Sidepanel)から1クリックでDOM構造を安全に吸い上げ |

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
- `--wait <ms>`: 動的レンダリングの待機時間（ミリ秒、デフォルト 2500）
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

Phase 1 で特定した情報をもとに、決定論的な ADF を作成します。

```json
{
  "action": "pipeline",
  "session_id": "production-checkout",
  "options": {
    "headless": true
  },
  "steps": [
    { "type": "capture", "op": "goto", "params": { "url": "https://example.com/login" } },
    { "type": "apply", "op": "fill", "params": { "selector": "#user-input", "value": "demo" } },
    { "type": "apply", "op": "click", "params": { "selector": "button[type='submit']" } },
    { "type": "capture", "op": "screenshot", "params": { "path": "active/shared/tmp/receipt.png" } }
  ]
}
```

- 一時的な検証は `active/shared/tmp/` 内で実施。
- 恒常的な業務フローとして再利用する場合は `pipelines/` ディレクトリへ昇格（`pnpm pipeline:promote`）させます。
