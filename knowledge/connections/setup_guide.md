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
  "default_channel": "#general"
}
```

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

## 2. 安全性の保証
`knowledge/personal/` は `.gitignore` により Git 管理から除外されています。ここに置かれた情報は外部に流出しません。
