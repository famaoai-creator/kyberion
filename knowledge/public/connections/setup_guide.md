---
title: ユニバーサル接続設定ガイド (UCM Setup)
category: Connections
tags: [connections, setup, guide]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# ユニバーサル接続設定ガイド (UCM Setup)

本エコシステムが外部ツールと連携するための認証情報は、**Personal Tier (`knowledge/personal/connections/`)** で一元管理します。

## 1. 設定ファイルの配置

以下のテンプレートを参考に、必要なサービスの JSON ファイルを作成し、`knowledge/personal/connections/` に配置してください。

### AWS (`aws.json`)

```json
{
  "profile": "default",
  "region": "ap-northeast-1"
}
```

※ 認証自体は `~/.aws/credentials` を参照します。

### Slack (`slack.json`)

```json
{
  "bot_token": "xoxb-your-token",
  "app_token": "xapp-your-socket-mode-token",
  "default_channel": "#general"
}
```

`slack-bridge` is Socket Mode based, so both `bot_token` and `app_token` are required for the managed surface to start successfully.

### Jira (`jira.json`)

```json
{
  "host": "https://your-domain.atlassian.net",
  "email": "user@example.com",
  "api_token": "your-api-token"
}
```

### Box (`box.json`)

Box Developer Console からダウンロードした `config.json` をそのまま配置してください。

### OAuth 2.0 系サービス (`canva.json` など)

```json
{
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "redirect_uri": "http://127.0.0.1:8787/oauth/callback",
  "scope": "design:meta:read asset:write"
}
```

OAuth broker を利用するサービスでは、認可コード交換後に `access_token` / `refresh_token` / `expires_at` が同じファイルへ自動保存されます。保存先は引き続き Personal Tier です。

ローカル callback は `oauth-callback-surface` が受けます。標準では `http://127.0.0.1:8787/oauth/callback` を使うので、OAuth provider 側の redirect URI にこの値を登録してください。

### X API MCP (`xapi`)

X 連携は接続ファイルではなく、まず環境変数で app credentials を渡します。Kyberion は `xurl` bridge を `stdio` MCP として起動し、`XAPI_CLIENT_ID` / `XAPI_CLIENT_SECRET` / `XAPI_REDIRECT_URI` を子プロセスへ注入します。

```bash
export XAPI_CLIENT_ID="your-x-app-client-id"
export XAPI_CLIENT_SECRET="your-x-app-client-secret"
export XAPI_REDIRECT_URI="http://localhost:8080/callback"
```

前提:

- X Developer Portal で OAuth 2.0 を有効化した app を作成する
- redirect URI として `http://localhost:8080/callback` を登録する
- 初回は `npx -y @xdevplatform/xurl auth oauth2 --headless` または Kyberion の `xapi:auth_status` / `xapi:list_tools` 実行時に認証を完了する

任意で `knowledge/personal/connections/xapi.json` に運用メモを置いても構いませんが、`client_secret` などの認証本体は引き続き環境変数で管理してください。

### X Docs MCP (`x-docs`)

X ドキュメント用 MCP は `https://docs.x.com/mcp` へ Kyberion から直接接続します。ローカルの app 登録や OAuth は不要です。

用途:

- X API の仕様確認
- ガイド / チュートリアル参照
- 利用可能な docs-side MCP tools / resources の列挙

## 2. 安全性の保証

`knowledge/personal/` は `.gitignore` により Git 管理から除外されています。ここに置かれた情報は外部に流出しません。
