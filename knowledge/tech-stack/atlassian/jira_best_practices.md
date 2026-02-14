# Jira 運用ベストプラクティス

## 1. チケットの階層構造

- **Epic**: 大きな機能群または四半期目標。
- **Story**: ユーザー価値を提供する最小単位。
- **Task/Bug**: 技術的な作業または不具合修正。

## 2. 記述の標準化

- **Title**: `[機能名] 概要` の形式を徹底。
- **Description**: 「背景」「期待される結果」「受入基準 (Acceptance Criteria)」を明記。

## 3. 自動化のルール

- GitHub PR が `ready for review` になった際、Jira ステータスを `In Review` へ自動遷移させる。
- PR マージ時に自動で `Done` へ。
