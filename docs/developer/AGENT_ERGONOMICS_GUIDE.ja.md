# Kyberion エージェント協調・運用ガイド (Agent Ergonomics Guide)

本書は、AI エージェントおよびオペレーターが Kyberion 上でスムーズ、高速、かつ安全に作業を遂行するための拡張機能と実際の利用手順をまとめたドキュメントです。

---

## 1. 自動修復（Auto-Heal / `--fix`）

### 概要

`pnpm run doctor`（または `pnpm kyberion doctor`）に `--fix` フラグを付与することで、未登録の常駐サービス、未同期のスケジュール、未作成のバックアップ／復元ドリルなどを自動検出し、安全に修復してシステムヘルスを正常化します。

### 使い方

```bash
# 診断と同時に安全な自動修復を実行
pnpm run doctor --fix

# 構造化 JSON で結果を受け取る場合
pnpm run doctor --fix --json
```

### 修復される項目

- **Chronos スケジューラ**: OS ユニットの登録および 42 パイプラインのスケジュール自動同期
- **Watchdog デーモン**: `daemon-watchdog` ユニットの自動登録
- **初期バックアップ**: `pipelines/backup-daily.json` の自動実行
- **復元ドリル**: `pipelines/backup-restore-drill.json` の自動実行

---

## 2. Fast-Context API（コンテキスト一括取得）

### 概要

AI エージェントが作業を開始する際、巨大な規約ドキュメント（`AGENTS.md` など）を複数回に分けて探索・取得するオーバーヘッドを排除し、**1 回の呼び出しで「スコープ・遵守ルール・アクチュエータ・要約」を凝縮して提供**します。

### 使い方

```bash
# 人間が読みやすい Markdown 形式で取得
node --import ./scripts/ts-loader.mjs scripts/context_pack.ts --task "code-refactor"

# エージェントが直接消費しやすい JSON 形式で取得
node --import ./scripts/ts-loader.mjs scripts/context_pack.ts --task "code-refactor" --json

# テナントや Tier を指定して取得
node --import ./scripts/ts-loader.mjs scripts/context_pack.ts --task "review" --tenant "my-tenant" --tier "confidential"
```

### 出力内容

- **Active Scope**: 現在の Tier (`public` / `confidential` / `personal`)、テナント、スタンス
- **Invariants**: 厳守すべき規約（Secure-IO 必須、Mission Controller 経由での状態変更など）
- **Capabilities**: 本環境で利用可能なマニフェスト一覧
- **Operating Guide**: 動作ガイドライン要約

---

## 3. Instant Run（軽量タスク用ファストパス）

### 概要

Git worktree の分離や本格的な Mission/WorkItem 起票・レビュー承認を必要としない、軽微な調査・プロトタイピング用の安全な一時サンドボックス（`active/shared/tmp/quick/`）実行ツールです。

### 使い方

```bash
# ドライラン（事前検証）
node --import ./scripts/ts-loader.mjs scripts/quick_task.ts --name "check-dependencies" --dry-run

# 一時サンドボックスでタスク実行
node --import ./scripts/ts-loader.mjs scripts/quick_task.ts --name "check-dependencies" --cmd "pnpm check"

# 実行結果とレシートパスを JSON で取得
node --import ./scripts/ts-loader.mjs scripts/quick_task.ts --name "inspect-schema" --json
```

### 特長

- **セキュアな一時隔離**: `active/shared/tmp/quick/<run-id>/` に実行レシート（`receipt.json`）を記録。
- **軽量**: フルミッションのオーバーヘッドなく、安全にコマンドを試行可能。

---

## 4. ガバナンス・開発者向け注意事項

これらのスクリプトは Kyberion の PR ガバナンスゲート（76 項目）に適合しています。

- スクリプト内のファイル操作は `@agent/core/secure-io` または `@agent/core/foundation` を使用。
- 一時ディレクトリ使用箇所は `knowledge/product/governance/shared-tmp-allowlist.json` に登録済み。
- 新規スクリプトは `knowledge/product/governance/orphan-baseline.json` に登録済み。
