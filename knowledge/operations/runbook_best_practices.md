# Runbook & Playbook Best Practices (AI-Native Operations)

生成AIによる自動実行（Autonomous Operations）を視野に入れた、次世代型の運用手順書の設計指針です。

## 1. 構造化とメタデータ (Structuring & Metadata)

AIがコンテキストを即座に理解できるよう、標準化されたヘッダーを設けます。

- **Metadata Header**: 手順書の冒頭に以下の情報を含めます。
  - **Target Service**: 対象となるマイクロサービスやコンポーネント名。
  - **Triggers**: このランブックを実行すべき条件（例: 特定のアラート名、しきい値）。
  - **Risk Level**: 低（読み取りのみ）、中（非破壊的変更）、高（サービス停止の可能性）。
  - **Prerequisites**: 必要な権限、ツール、接続先。
- **Markdown Standard**: 機械可読性と人間による視認性を両立するため、標準的なMarkdownを使用します。

## 2. 実行可能な手順設計 (Executable Steps)

手順を「説明」ではなく「コマンド」として記述します。

- **Code Blocks**: 実行コマンドは常にバッククォートで囲んだコードブロックとして記述し、言語（bash, python, sql等）を明記します。
- **Variable Injection**: 環境変数やパラメータは `{{VARIABLE_NAME}}` のような形式で記述し、AIが値を注入しやすくします。
- **Validation (Assert)**: 各ステップの実行後、成功したかどうかを判断するための確認コマンド（例: `curl` でステータスコードを確認）をセットで記述します。
- **Idempotency (べき等性)**: 同じ手順を2回実行しても安全（既に適用済みならスキップする等）であるようにスクリプトを設計します。

## 3. 安全性とエラーハンドリング (Safety & Error Handling)

AIの暴走を防ぎ、安全な復旧を保証します。

- **Human-in-the-loop (HITL)**: リスクが高いステップ（例: DBの削除、本番環境の再起動）の前には、必ず人間の承認を求める指示を明記します。
- **Rollback Procedures**: 各「変更」ステップに対して、対になる「切り戻し」ステップを必ず用意します。
- **Stop Conditions**: 期待される結果が得られない場合、それ以上のステップ進まずに停止し、人間を呼び出す（Escalate）条件を定義します。

## 4. AIエージェントへの最適化 (AI Agent Optimization)

- **Annotation**: コメントアウト等を使用して、各コマンドの「意図（Why）」を記述します。AIはこの情報を元に、現在の状況にその手順が適しているか判断します。
- **Dry Run Mode**: 実際に変更を加える前に、何が起こるかを確認する `dry-run` オプションの提供を推奨します。
- **Log Collection**: 実行結果（標準出力、エラー出力）を自動的に記録し、後のポストモーテムに活用できる構成にします。
