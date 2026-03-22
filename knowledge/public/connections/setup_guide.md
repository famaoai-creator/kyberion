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

## 2. 安全性の保証

`knowledge/personal/` は `.gitignore` により Git 管理から除外されています。ここに置かれた情報は外部に流出しません。
