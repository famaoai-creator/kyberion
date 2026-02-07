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
5. **PR作成**: `pr-architect` を用い、変更内容、テスト結果、影響範囲を網羅したPR本文を構成し、PRを発行。

## 3. マージ条件
- `test-genie` による全テストのパス。
- `security-scanner` による脆弱性・シークレット検知のクリア。
- （シミュレーション上は）エージェントによる最終品質確認の完了。
