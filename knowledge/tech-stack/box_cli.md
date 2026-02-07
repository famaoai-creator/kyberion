# Box CLI 活用ガイド

大量のファイル操作や、スクリプトレスでの定型処理に適した Box CLI の利用方法。

## 1. インストール
- **macOS/Linux**: `brew install boxcli` (Homebrew)
- **Windows**: MSIインストーラーを使用。

## 2. 認証 (JWT)
SDKと同じ `config.json` を使用して、非対話的にログインが可能。
```bash
box configure:environments:add <path/to/config.json> --name my-env
box login -n my-env --user-id <App-User-ID>
```

## 3. 主なユースケースとコマンド
- **一括アップロード**: ディレクトリ構造を維持してアップロード。
  ```bash
  box folders:upload <local-dir> --parent-id <folder-id>
  ```
- **検索**: メタデータやキーワードで検索し、結果をJSONで取得。
  ```bash
  box search "Project X" --json
  ```
- **ユーザー管理**: 多数のユーザーを一括作成・招待。
  ```bash
  box users:create "Taro Yamada" --login "taro@example.com"
  ```

## 4. SDKとの使い分け
- **CLI推奨**: シェルスクリプトへの組み込み、TB級データの移行、初期セットアップ。
- **SDK推奨**: アプリケーションへの組み込み、複雑なロジック分岐、オンメモリ処理。
