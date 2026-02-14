# 企業内ネットワーク環境セットアップガイド

企業PCなど、プロキシや制限されたネットワーク下で本モノレポを使用するための手順。

## 1. プロキシ設定

多くのスキル（`web_fetch`, `npm install`等）がインターネット接続を必要とします。

### 環境変数

`.bashrc` または `.zshrc` に以下を追記：

```bash
export http_proxy=http://proxy.your-company.co.jp:8080
export https_proxy=http://proxy.your-company.co.jp:8080
```

### Git / GitHub CLI

```bash
git config --global http.proxy http://proxy.your-company.co.jp:8080
gh config set proxy http://proxy.your-company.co.jp:8080
```

### NPM

```bash
npm config set proxy http://proxy.your-company.co.jp:8080
npm config set https-proxy http://proxy.your-company.co.jp:8080
```

## 2. SSL証明書のエラー対応

社内プロキシによるSSLインターセプトが発生する場合：

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0 # 開発・一時利用のみ
```

## 3. 実行権限の制約

`setup_ecosystem.sh` に実行権限がない場合：

```bash
chmod +x scripts/*.sh
```
