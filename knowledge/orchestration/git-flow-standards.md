# 自律的 Git ブランチ・PR 運用基準 (Git Flow Standards)

本エコシステムがコードを変更する際の標準的な Git 手順。

## 1. 原則

- **Direct Push 禁止**: `main` (または `master`) ブランチへの直接プッシュは原則禁止。
- **機能別ブランチ**: すべての変更は `feat/`, `fix/`, `docs/`, `refactor/` プレフィックスを持つ新ブランチで行う。

## 2. 標準手順

1. **ブランチ作成**: `git checkout -b <prefix>/<feature-name>`
2. **実装・テスト**: ハイブリッドTDDフローに従い、実装とカバレッジを確保。
3. **セルフレビュー**: `local-reviewer` を実行し、差分の整合性を確認。
4. **プッシュ**: `git push origin <branch-name>`
5. **PR作成**: `gh pr create` (GitHub CLI) または Web UI を使用。
   - **本文必須項目**: 概要、変更点、**ローカルでの実行エビデンス（テストパスのログ等）**。

## 3. マージとクリーンアップ

- マージ後は速やかにリモートおよびローカルの作業ブランチを削除する。
- `gh pr merge --delete-branch` の使用を推奨。
