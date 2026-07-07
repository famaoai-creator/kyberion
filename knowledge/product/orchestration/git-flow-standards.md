---
title: 自律的 Git ブランチ・PR 運用基準 (Git Flow Standards)
category: Orchestration
tags: [orchestration, git, flow, standards]
importance: 8
author: Ecosystem Architect
last_updated: 2026-07-07
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

証跡中心の開発ワークフロー全体は [`kyberion-development-workflow.md`](./kyberion-development-workflow.md) を参照する。

## 1. 原則

- **Direct Push 禁止**: `main` (または `master`) ブランチへの直接プッシュは原則禁止。
- **機能別ブランチ**: すべての変更は `feat/`, `fix/`, `docs/`, `refactor/` プレフィックスを持つ新ブランチで行う。
- **証跡を先に設計する**: PR に載せる evidence / trace / validation を先に決めてから実装を始める。
- **依存修正は分割しない**: 相互依存する変更は、レビューしやすい単位までまとめて同じ worktree で実施する。別 worktree に分けるのは、独立性が高く、レビュー上も分けた方が明確な場合に限る。

## 2. 標準手順

1. **origin/main を最新化**: `git fetch origin` してから、`git switch main && git pull --ff-only origin main` で基点を揃える。
2. **worktree を作成**: `git worktree add -b <prefix>/<feature-name> <worktree-path> origin/main` か、最新の `main` を起点に同等の手順を取る。
3. **mission / workitem を固定する**: 実装前に、どの mission と workitem に紐づく変更かを決め、PR で追跡できるようにする。
4. **実装・テスト**: ハイブリッドTDDフローに従い、依存する変更は同じ worktree にまとめて実装とカバレッジを確保する。
5. **証跡を残す**: evidence / trace / summary を workitem の出力として残し、PR の本文に参照を貼る。
6. **CI 事前チェック**: PR を出す前に、少なくとも `pnpm validate` を実行する。重い場合でも、変更に直結するチェック群は必ず走らせる。
7. **PR タイトル検査**: `pnpm check:pr-title -- --title "<proposed title>"` を実行し、PR タイトルが Conventional Commits に沿っているか確認する。`pr:create` を使う場合も同じ制約に従う。
8. **セルフレビュー**: `local-reviewer` を実行し、差分の整合性を確認。
9. **PR 作成**: `gh pr create` (GitHub CLI) または Web UI を使用。レビューコメントが付いたら、同じ branch / worktree で修正する。
   - **本文必須項目**: 概要、変更点、mission / workitem / evidence / trace の参照、**ローカルでの実行エビデンス（テストパスのログ等）**。

## 3. マージとクリーンアップ

1. **マージ確認**: PR がマージされたら、`git switch main && git pull --ff-only origin main` で `origin/main` に追従する。
2. **worktree 整理**: その変更に使った worktree を削除し、不要になった作業ブランチを片付ける。
3. **残骸掃除**: 使い終わった一時 clone / temp artifact があれば、ここで整理する。
4. `gh pr merge --delete-branch` の使用を推奨する。

## 4. See Also

- [`kyberion-development-workflow.md`](./kyberion-development-workflow.md)
- [`work-coordination-platform.md`](./work-coordination-platform.md)
