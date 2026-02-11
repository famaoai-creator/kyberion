# Cross-Role Directive Protocol (CRDP)

本プロトコルは、Gemini Skills エコシステム内の異なるロール間でタスクを依頼・委譲する際の標準フォーマットを定義する。

## 1. 指示書の基本構造 (The Template)
依頼者は以下の項目を網羅した Markdown 形式の指示書を発行しなければならない。

```markdown
# MISSION: [ミッション名]
- **FROM**: [依頼元ロール名]
- **TO**: [実行先ロール名]
- **STATUS**: [Draft | Issued | In Progress | Completed]

## 1. 目的 (Objective)
何のためにこのタスクを行うのか。達成したいビジネス上の価値や技術的目標。

## 2. コンテキスト & リソース (Context & Resources)
実行にあたって参照すべき既存のナレッジやデータ。
- `knowledge/...` : 関連する規約やマニュアル
- `work/...` : 過去の実行結果や中間成果物

## 3. 勝利条件 (Victory Conditions)
「何をもって完了とするか」の定量的・定性的なチェックリスト。
- [ ] [条件1]
- [ ] [条件2]

## 4. 制約事項 (Constraints)
- **Knowledge Tier**: [Personal | Confidential | Public] の指定。
- **Tools**: 使用を推奨（または禁止）する特定のスキル。
- **Deadline/Priority**: 優先順位や期限。

## 5. アウトプット形式 (Handover Spec)
成果物の保存先とフォーマット。
- 保存先: `work/outputs/[filename]`
- 形式: [Markdown | JSON | PPTX | etc.]
```

## 2. 依頼のフロー
1.  **Directive Creation**: 依頼元ロールが上記テンプレートに従い指示書（Markdown）を作成し、`work/directives/` 配下に保存する。
2.  **Role Switching**: ユーザー（または自動化された `mission-control`）が実行先ロールにスイッチする。
3.  **Context Loading**: 実行先ロールは `work/directives/` の最新ファイルを読み込み、自身のミッション定義と照らし合わせて実行を開始する。
4.  **Reporting**: 完了後、指示書のチェックリストを埋め、成果物を指定場所に保存して報告する。

## 4. 特殊な指示書
- **オンボーディング指示書 (Onboarding Directives)**: 
    - 各ロールが初回起動時に実行すべき、自己の専門性を確立するための情報収集指示。
    - 配置場所: `knowledge/orchestration/onboarding-directives/`
    - 特徴: 恒久的なナレッジ資産であり、全ロールの「初期化プロセス」の核となる。
