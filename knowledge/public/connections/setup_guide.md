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

## 0. クレデンシャルの登録 (canonical)

トークンや API キーなどの**シークレット本体**は Secret Guard 経由で登録するのが正規ルートです。

```bash
pnpm kyberion secret introduce <serviceId> <secretKey>
# 例: pnpm kyberion secret introduce slack ACCESS_TOKEN   # xoxb-... を貼る
#     pnpm kyberion secret introduce slack APP_TOKEN      # xapp-... を貼る
```

`<secretKey>` はサービスごとのサフィックスです（`<SERVICE_ID>_<SUFFIX>` という環境変数名に対応）。主要なサフィックスは `ACCESS_TOKEN` / `BOT_TOKEN` / `TOKEN`（同じものを指す別名）と `APP_TOKEN`、`REFRESH_TOKEN`、`CLIENT_ID`、`CLIENT_SECRET`、`REDIRECT_URI` で、各サービスで受理される名称は `pnpm service:setup` の `SECRETS` 列に表示されます。

シークレットの解決順は次の通りです。上位で見つかったものが優先されます。

1. 実行コンテキストの環境変数 (`SLACK_BOT_TOKEN` など)
2. Secret Guard vault (`vault/secrets/secrets.json`) + OS keychain（`secret introduce` の書き込み先）
3. 接続ファイル (`connections/<service>.json`) 内の同名キー — 後方互換のフォールバックとして残っています

`knowledge/personal/connections/<service>.json` の接続ファイルは、**非シークレットの既定パラメータ**（ホスト名・既定チャネル・既定ディレクトリなど）を与えるもので、プリセット操作の実行時にパラメータへマージされます。シークレットを直接書くことも解決上は機能しますが、新規セットアップでは `secret introduce` に寄せてください。

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

トークンは `secret introduce` で登録します（`SLACK_BOT_TOKEN`/`SLACK_ACCESS_TOKEN` に `xoxb-`、`SLACK_APP_TOKEN` に `xapp-` の Socket Mode トークン）。接続ファイルには既定値だけを置きます。

```json
{
  "default_channel": "#general"
}
```

`slack-bridge` is Socket Mode based, so both the bot token and the app token are required for the managed surface to start successfully. `default_channel` はプリセット操作の送信先の既定値です。オペレーターへの通知ルーティング（承認依頼やアラートの届け先）は別設定で、`knowledge/personal/notification-preferences.json` の `default_channel: { "surface": "slack", "target": "<channel-id>" }` または `KYBERION_OPERATOR_SLACK_DM` を使います。

### Jira (`jira.json`)

```json
{
  "domain": "your-domain",
  "email": "user@example.com",
  "api_token": "your-api-token"
}
```

`domain` は `your-domain.atlassian.net` のサブドメイン部分だけを書きます（`https://` やドメイン全体は不要）。Atlassian の Basic 認証は `email:api_token` ペアなので `email` も必須です。`api_token` は `pnpm kyberion secret introduce jira API_TOKEN` での登録が正規ルートです（接続ファイルへの直書きはフォールバックとして機能します）。

### Confluence (`confluence.json`)

```json
{
  "domain": "your-domain",
  "email": "user@example.com",
  "token": "your-api-token"
}
```

`domain` は `your-domain.atlassian.net` のサブドメイン部分。トークンは `pnpm kyberion secret introduce confluence TOKEN` が正規ルートです。

### Zendesk (`zendesk.json`)

```json
{
  "subdomain": "your-subdomain",
  "email": "user@example.com/token",
  "token": "your-api-token"
}
```

Zendesk の API トークン Basic 認証はユーザー部が `email/token` 形式です（`email` フィールドに `/token` を付けてください）。トークンは `pnpm kyberion secret introduce zendesk TOKEN` が正規ルートです。

### Backlog (`backlog.json`)

```json
{
  "space": "your-space"
}
```

`space` は `your-space.backlog.com` のスペース名。API キーは `pnpm kyberion secret introduce backlog API_KEY` で登録します。

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

## 2. 検証

登録が済んだら次で確認します。

```bash
pnpm service:setup        # auth / connection / secrets の一覧
pnpm service:preflight    # 実行時の readiness ゲート
pnpm surfaces             # 管理対象サーフェス（slack-bridge 等）の状態
```

`AUTH` が `ready` なら Secret Guard 経由でトークンが解決できています。`CONNECTION` は接続キーを宣言しているサービス（comfyui / whisper / voice / meeting）だけが `missing` になり、`optional` は接続ファイルが任意であることを示します。

## 3. 安全性の保証

`knowledge/personal/` は `.gitignore` により Git 管理から除外されています。ここに置かれた情報は外部に流出しません。
