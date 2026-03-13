# 要件ドキュメント

## はじめに

本ドキュメントは、Kyberionプロジェクト全体の品質向上を目的とした改善計画の要件を定義します。現在、テストカバレッジの不足、TypeScript設定の緩さ、ESLintルールの無効化、モノレポ構造の未整理など、複数の技術的負債が存在しています。これらを段階的に改善し、プロジェクトの保守性、信頼性、開発効率を向上させることを目指します。

## 用語集

- **Test_Coverage_System**: テストカバレッジを測定・報告するシステム（c8、vitest coverage）
- **Type_Safety_Enforcer**: TypeScriptコンパイラの型安全性チェック機能
- **Lint_Rule_Engine**: ESLintによるコード品質チェックエンジン
- **Actuator**: Kyberionエコシステムにおける物理的実装を担うモジュール（14種類存在）
- **Shared_Package**: 複数のアクチュエータで共有されるライブラリパッケージ（shared-media, shared-vision等）
- **CI_Pipeline**: 継続的インテグレーションパイプライン（GitHub Actions）
- **Monorepo_Structure**: pnpm workspacesによるモノレポ構成
- **Kyberion_Framework**: Kyberionの統治フレームワーク（AGENTS.md）

## 要件

### 要件1: アクチュエータのテストカバレッジ拡充

**ユーザーストーリー:** 開発者として、すべてのアクチュエータが適切にテストされていることを確認したい。これにより、リファクタリングや機能追加時の回帰バグを防止できる。

#### 受入基準

1. THE Test_Coverage_System SHALL 各アクチュエータのテストカバレッジを測定する
2. WHEN 新しいアクチュエータテストが作成される場合、THE Test_Coverage_System SHALL 最低60%のカバレッジを達成する
3. THE Test_Coverage_System SHALL blockchain-actuator, browser-actuator, code-actuator, daemon-actuator, file-actuator, media-actuator, modeling-actuator, network-actuator, orchestrator-actuator, physical-bridge, secret-actuator, service-actuator, system-actuator, wisdom-actuatorの14個すべてに対してテストを実行する
4. WHEN アクチュエータテストが実行される場合、THE Test_Coverage_System SHALL 各アクチュエータの主要な公開APIをカバーする
5. THE Test_Coverage_System SHALL テストカバレッジレポートをHTML形式で出力する

### 要件2: 共有パッケージのテストカバレッジ拡充

**ユーザーストーリー:** 開発者として、共有パッケージが適切にテストされていることを確認したい。これにより、複数のアクチュエータに影響する変更を安全に行える。

#### 受入基準

1. THE Test_Coverage_System SHALL shared-media, shared-vision, shared-network, shared-business, shared-nerveの5つすべてに対してテストを実行する
2. WHEN 共有パッケージテストが作成される場合、THE Test_Coverage_System SHALL 最低70%のカバレッジを達成する
3. THE Test_Coverage_System SHALL 各共有パッケージの公開APIをカバーする
4. WHEN 共有パッケージが変更される場合、THE Test_Coverage_System SHALL 依存するアクチュエータのテストも実行する

### 要件3: スクリプトの重要機能のテストカバレッジ拡充

**ユーザーストーリー:** 開発者として、重要なスクリプトが適切にテストされていることを確認したい。これにより、システムの中核機能の信頼性を保証できる。

#### 受入基準

1. THE Test_Coverage_System SHALL mission_controller.ts, run_pipeline.ts, system_whisperer.ts, run_orchestration_job.tsの重要スクリプトに対してテストを実行する
2. WHEN スクリプトテストが作成される場合、THE Test_Coverage_System SHALL 最低50%のカバレッジを達成する
3. THE Test_Coverage_System SHALL 各スクリプトの主要な実行パスをカバーする
4. WHEN スクリプトがエラーハンドリングを含む場合、THE Test_Coverage_System SHALL エラーケースもカバーする

### 要件4: TypeScript厳格モードへの段階的移行

**ユーザーストーリー:** 開発者として、TypeScriptの型安全性を段階的に向上させたい。これにより、実行時エラーを減らし、コードの保守性を向上させる。

#### 受入基準

1. THE Type_Safety_Enforcer SHALL 新規作成されるファイルに対してstrict: trueを適用する
2. WHEN 既存ファイルが大幅に変更される場合、THE Type_Safety_Enforcer SHALL そのファイルに対してnoImplicitAny: trueを適用する
3. THE Type_Safety_Enforcer SHALL 段階的移行のための中間設定ファイル（tsconfig.strict.json）を提供する
4. THE Type_Safety_Enforcer SHALL 移行対象ファイルのリストを管理する
5. WHEN すべての対象ファイルが移行完了した場合、THE Type_Safety_Enforcer SHALL tsconfig.jsonのstrict設定をtrueに更新する

### 要件5: ESLintルールの段階的有効化

**ユーザーストーリー:** 開発者として、コード品質を段階的に向上させたい。これにより、バグの早期発見と一貫したコーディングスタイルを実現できる。

#### 受入基準

1. THE Lint_Rule_Engine SHALL @typescript-eslint/no-explicit-anyルールを'warn'レベルで有効化する
2. THE Lint_Rule_Engine SHALL @typescript-eslint/no-unused-varsルールを'warn'レベルで有効化する
3. WHEN 新規作成されるファイルの場合、THE Lint_Rule_Engine SHALL すべてのルールを'error'レベルで適用する
4. THE Lint_Rule_Engine SHALL 既存ファイルに対する段階的移行計画を提供する
5. WHEN すべての警告が解消された場合、THE Lint_Rule_Engine SHALL ルールレベルを'error'に昇格させる

### 要件6: モノレポ構造の整理

**ユーザーストーリー:** 開発者として、モノレポ構造を整理したい。これにより、コードの発見性と保守性を向上させる。

#### 受入基準

1. THE Monorepo_Structure SHALL libs/core/配下の150以上のファイルをsrc/ディレクトリに整理する
2. THE Monorepo_Structure SHALL 各パッケージのpackage.jsonにmain, types, exportsフィールドを定義する
3. THE Monorepo_Structure SHALL 各shared-\*パッケージの依存関係を明示的に宣言する
4. WHEN ファイルが移動される場合、THE Monorepo_Structure SHALL すべてのインポートパスを自動的に更新する
5. THE Monorepo_Structure SHALL 循環依存を検出し報告する

### 要件7: CI/CDパイプラインの強化

**ユーザーストーリー:** 開発者として、CI/CDパイプラインを強化したい。これにより、品質問題を早期に発見し、デプロイの信頼性を向上させる。

#### 受入基準

1. THE CI_Pipeline SHALL すべてのプルリクエストに対してテストを自動実行する
2. THE CI_Pipeline SHALL テストカバレッジレポートを生成しコメントとして投稿する
3. THE CI_Pipeline SHALL TypeScript型チェックを実行する
4. THE CI_Pipeline SHALL ESLintチェックを実行し、警告数を報告する
5. WHEN カバレッジが閾値を下回る場合、THE CI_Pipeline SHALL プルリクエストをブロックする
6. THE CI_Pipeline SHALL 依存関係の脆弱性スキャンを実行する
7. THE CI_Pipeline SHALL ビルド成果物のサイズを測定し報告する

### 要件8: ドキュメントの一貫性向上

**ユーザーストーリー:** 開発者として、ドキュメントの言語を統一したい。これにより、プロジェクトの理解を容易にする。

#### 受入基準

1. THE Monorepo_Structure SHALL 各パッケージのREADME.mdを日本語で提供する
2. THE Monorepo_Structure SHALL コード内のコメントを日本語または英語で統一する
3. WHEN 新しいドキュメントが作成される場合、THE Monorepo_Structure SHALL 言語ガイドラインに従う
4. THE Monorepo_Structure SHALL APIドキュメントを自動生成する

### 要件9: テストインフラストラクチャの改善

**ユーザーストーリー:** 開発者として、テストの実行速度と信頼性を向上させたい。これにより、開発サイクルを高速化できる。

#### 受入基準

1. THE Test_Coverage_System SHALL テストを並列実行する
2. THE Test_Coverage_System SHALL テスト結果をキャッシュし、変更されたファイルのみ再実行する
3. WHEN テストが失敗する場合、THE Test_Coverage_System SHALL 詳細なエラーメッセージとスタックトレースを提供する
4. THE Test_Coverage_System SHALL テスト実行時間を測定し、遅いテストを報告する
5. THE Test_Coverage_System SHALL モックとスタブのユーティリティを提供する

### 要件10: 品質メトリクスの可視化

**ユーザーストーリー:** 開発者として、プロジェクトの品質メトリクスを可視化したい。これにより、改善の進捗を追跡できる。

#### 受入基準

1. THE CI_Pipeline SHALL テストカバレッジの推移をグラフで表示する
2. THE CI_Pipeline SHALL TypeScriptエラー数の推移を追跡する
3. THE CI_Pipeline SHALL ESLint警告数の推移を追跡する
4. THE CI_Pipeline SHALL コード複雑度メトリクスを計算する
5. WHEN メトリクスが悪化する場合、THE CI_Pipeline SHALL 通知を送信する

### 要件11: Kyberion準拠の検証強化

**ユーザーストーリー:** 開発者として、AGENTS.mdで定義された原則への準拠を自動的に検証したい。これにより、アーキテクチャの一貫性を保証できる。

#### 受入基準

1. THE Lint_Rule_Engine SHALL node:fsとchild_processの直接使用を検出しエラーを報告する（既存機能の確認）
2. THE Lint_Rule_Engine SHALL @agent/core/secure-ioの使用を推奨する
3. THE Lint_Rule_Engine SHALL mission_controller.tsを使用しないミッション管理を検出する
4. THE Lint_Rule_Engine SHALL ADF形式以外のアクチュエータ呼び出しを検出する
5. WHEN Kyberion原則違反が検出される場合、THE Lint_Rule_Engine SHALL 修正方法を提案する

### 要件12: 段階的移行計画の管理

**ユーザーストーリー:** 開発者として、品質改善の進捗を追跡したい。これにより、計画的に技術的負債を解消できる。

#### 受入基準

1. THE Monorepo_Structure SHALL 移行対象ファイルのリストを.kiro/migration/配下に保存する
2. THE Monorepo_Structure SHALL 移行完了ファイルを自動的にマークする
3. THE Monorepo_Structure SHALL 移行進捗レポートを生成する
4. WHEN 移行が完了する場合、THE Monorepo_Structure SHALL 設定ファイルを自動的に更新する
5. THE Monorepo_Structure SHALL 移行履歴をGitコミットメッセージに記録する

## 実装の優先順位

本要件の実装は以下の優先順位で段階的に進めることを推奨します：

1. **フェーズ1（基盤整備）**: 要件9（テストインフラ）、要件7（CI/CD）
2. **フェーズ2（テスト拡充）**: 要件1（アクチュエータテスト）、要件2（共有パッケージテスト）、要件3（スクリプトテスト）
3. **フェーズ3（型安全性）**: 要件4（TypeScript厳格化）、要件12（移行管理）
4. **フェーズ4（コード品質）**: 要件5（ESLint有効化）、要件11（Kyberion準拠）
5. **フェーズ5（構造改善）**: 要件6（モノレポ整理）、要件8（ドキュメント統一）
6. **フェーズ6（可視化）**: 要件10（メトリクス可視化）

各フェーズは独立して実装可能ですが、前のフェーズの完了が推奨されます。
