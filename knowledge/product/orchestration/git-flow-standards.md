---
title: 自律的 Git ブランチ・PR 運用基準 (Git Flow Standards)
category: Orchestration
tags: [orchestration, git, flow, standards]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-22
---

# 自律的 Git ブランチ・PR 運用基準 (Git Flow Standards)

本エコシステムがコードを変更する際の標準的な Git 手順。

Kyberion の改善タスクは、原則として以下の順で進める。

1. `origin/main` を最新にする。
2. そこを起点に worktree を切る。
3. 依存関係がある修正は同一 worktree でまとめて完結させる。
4. 実装・検証後に PR を出す。
5. コメントが付いたら同じ worktree / 同じ branch で追修正する。
6. マージされたら `origin/main` に追従し、worktree を片付ける。

## 1. 原則

- **Direct Push 禁止**: `main` (または `master`) ブランチへの直接プッシュは原則禁止。
- **機能別ブランチ**: すべての変更は `feat/`, `fix/`, `docs/`, `refactor/` プレフィックスを持つ新ブランチで行う。
- **依存修正は分割しない**: 相互依存する変更は、レビューしやすい単位までまとめて同じ worktree で実施する。別 worktree に分けるのは、独立性が高く、レビュー上も分けた方が明確な場合に限る。

## 2. 標準手順

1. **origin/main を最新化**: `git fetch origin` してから、`git switch main && git pull --ff-only origin main` で基点を揃える。
2. **worktree を作成**: `git worktree add -b <prefix>/<feature-name> <worktree-path> origin/main` か、最新の `main` を起点に同等の手順を取る。
3. **実装・テスト**: ハイブリッドTDDフローに従い、依存する変更は同じ worktree にまとめて実装とカバレッジを確保する。
4. **セルフレビュー**: `local-reviewer` を実行し、差分の整合性を確認。
5. **PR 前確認と PR 作成**: [PR前CI準備チェックリスト](../governance/pre-pr-ci-readiness-checklist.ja.md)の「PR 作成手順」に従う。`pnpm check -- --scope pr` → タイトル検査 → テンプレートから本文作成 → push → `pnpm kyberion pr create --title ... --body-file ...` → `gh pr checks --watch` の順で、base は `main` にする。大規模変更や release のときは追加で `pnpm validate` を実行する。
6. **レビュー対応**: レビューコメントが付いたら、同じ branch / worktree で修正する。

## 3. マージとクリーンアップ

1. **マージ確認**: PR がマージされたら、`git switch main && git pull --ff-only origin main` で `origin/main` に追従する。
2. **worktree 整理**: その変更に使った worktree を削除し、不要になった作業ブランチを片付ける。
3. **残骸掃除**: 使い終わった一時 clone / temp artifact があれば、ここで整理する。
4. `gh pr merge --delete-branch` の使用を推奨する。
