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

## 5. 保存スコープの強制制御 (Storage Scope Enforcement)

ナレッジの3層構造に基づき、ロールの権限に応じて成果物の保存先を厳格に制限する。

- **Ecosystem Architect (基盤管理者)**:
  - **Public Tier (`knowledge/`)**: 唯一の書き込み権限保持。共通規約、全ロール共通スキル・新スキルの追加を担当。
  - **Confidential/Personal Tier**: **書き込み・修正は原則禁止。** 基盤設計のための参照のみに留める。
- **その他の実務ロール (Strategic Sales, Engineering, etc.)**:
  - **Public Tier (`knowledge/`)**: **書き込み・修正は厳禁。**
  - **Confidential Tier (`knowledge/confidential/`)**: クライアント資産の主要な保存先。
  - **Personal Tier (`knowledge/personal/`)**: ユーザー固有の嗜好、設定、プライベートなメモの保存先。
  - **Temporary (`work/`)**: 実行時の中間成果物。

### 資産配置の原則

1. **クライアント・プロジェクトに関連するもの**: 無条件で `knowledge/confidential/` 以下の適切なサブディレクトリへ保存。
2. **個人の設定や特定の環境に依存するもの**: `knowledge/personal/` または `work/` へ保存。
3. **汎用的な「標準」を更新したい場合**: 必ず `Ecosystem Architect` へ「共通化の提案」を行い、承認後にロールをスイッチして実施する。

## 6. アウトプット形式 (Handover Spec)

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
