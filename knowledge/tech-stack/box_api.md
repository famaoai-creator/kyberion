# Box API 連携ガイド (Node.js SDK)

本ドキュメントは、Box上のファイルをプログラムから安全に取得するための認証とAPI利用のベストプラクティスをまとめたものです。

## 1. 認証方式: JWT (Server-to-Server)
サーバーサイドのバッチ処理や自動化スクリプトでは、ユーザー操作を必要としない **JWT (JSON Web Token)** 認証を推奨します。

### セットアップ手順
1. **Box Developer Console** で「カスタムアプリ」を作成し、認証方式に「JWT」を選択。
2. **構成設定** タブで「公開/秘密キーペアを生成」をクリック。
3. ダウンロードされた `config.json` を安全な場所（`knowledge/personal/` または秘密管理マネージャ）に保存。

## 2. Node.js SDK の利用
`box-node-sdk` を使用してクライアントを初期化します。

```javascript
const BoxSDK = require('box-node-sdk');
const fs = require('fs');

// config.json を読み込み
const config = JSON.parse(fs.readFileSync('path/to/config.json'));
const sdk = BoxSDK.getPreconfiguredInstance(config);
const client = sdk.getAppAuthClient('enterprise');
```

## 3. ファイルダウンロード・パターン
- **Stream**: メモリ不足を防ぐため、`files.getReadStream(fileId)` を使用してストリームで処理する。
- **検索**: `search.query(query)` でファイルIDを特定してからダウンロードするフローが一般的。
