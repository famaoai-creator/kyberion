# Build Size Metrics

このディレクトリには、ビルド成果物のサイズメトリクスが保存されます。

## ファイル

### build-size-history.json

ビルドサイズの履歴データを保存します。最新50件のビルドレポートが保持されます。

**構造:**

```json
{
  "version": "1.0.0",
  "reports": [
    {
      "timestamp": "2024-03-13T00:00:00.000Z",
      "commit": "abc123...",
      "totalSize": 12345678,
      "totalSizeFormatted": "11.77 MB",
      "packages": [...],
      "actuators": [...],
      "sharedPackages": [...],
      "scripts": [...]
    }
  ]
}
```

## スクリプト

### scripts/measure-build-size.ts

ビルド成果物のサイズを測定し、レポートを生成します。

**使用方法:**

```bash
# Markdown形式でレポートを生成（デフォルト）
npx tsx scripts/measure-build-size.ts

# JSON形式でレポートを生成
npx tsx scripts/measure-build-size.ts --json

# 履歴に保存せずにレポートを生成
npx tsx scripts/measure-build-size.ts --no-save
```

**機能:**

1. **個別パッケージサイズの測定**
   - Core
   - Actuators（14個）
   - Shared Packages（5個）
   - Scripts

2. **前回ビルドとの比較**
   - サイズの増減を検出
   - パーセンテージ変化を計算
   - 新規パッケージを識別

3. **閾値アラート**
   - サイズが1MB以上増加した場合に警告
   - サイズが10%以上増加した場合に警告

4. **レポート生成**
   - Markdown形式（PRコメント用）
   - JSON形式（プログラム処理用）

## CI/CD統合

GitHub Actionsワークフロー（`.github/workflows/pr-validation.yml`）は、各PRに対して自動的にビルドサイズを測定し、結果をPRコメントとして投稿します。

**ワークフローステップ:**

1. **Measure build size**: ビルド成果物のサイズを測定
2. **Comment build size report on PR**: 測定結果をPRにコメント
3. **Upload build size artifacts**: レポートをアーティファクトとして保存

## 閾値設定

現在の閾値設定（`scripts/measure-build-size.ts`内）:

- **THRESHOLD_BYTES**: 1MB（1,048,576バイト）
- **THRESHOLD_PERCENT**: 10%

これらの値を超えるサイズ増加があった場合、レポートに警告が表示されます。

## メトリクスの活用

### サイズ増加の調査

ビルドサイズが大幅に増加した場合:

1. レポートで最も増加したパッケージを特定
2. そのパッケージの変更内容を確認
3. 不要な依存関係や大きなファイルがないか確認
4. 必要に応じてコードを最適化

### 履歴データの分析

```bash
# 履歴データを表示
cat .kiro/metrics/build-size-history.json | jq '.reports[-5:]'

# 総サイズの推移を表示
cat .kiro/metrics/build-size-history.json | jq '.reports[] | {timestamp, totalSize: .totalSizeFormatted}'
```

## トラブルシューティング

### dist/ディレクトリが見つからない

```bash
# ビルドを実行
pnpm run build

# その後、サイズ測定を実行
npx tsx scripts/measure-build-size.ts
```

### 履歴ファイルが破損した場合

```bash
# 履歴ファイルを削除（次回実行時に再作成されます）
rm .kiro/metrics/build-size-history.json
```

### PRコメントが投稿されない

GitHub Actionsワークフローに必要な権限があることを確認:

```yaml
permissions:
  contents: read
  pull-requests: write
```

## 要件との対応

このビルドサイズ測定機能は、以下の要件を満たします:

- **要件7.7**: ビルド成果物のサイズを測定し報告する
  - ✅ 個別パッケージサイズの測定
  - ✅ 前回ビルドとの比較
  - ✅ PRコメントでの報告
  - ✅ サイズ閾値アラート
