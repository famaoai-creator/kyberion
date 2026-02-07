# ハイブリッド型AIネイティブ開発フロー (Hybrid AI-Native Flow)

「信頼性（TDD）」と「効率性（AI-Direct）」を両立し、最小のトークンコストで最大の品質（カバレッジ 90% 以上）を達成するための標準手順。

## 1. 識別フェーズ (Identify)
- **コアロジック (Critical)**: 計算、検索アルゴリズム、認証、複雑なデータ変換。 -> **TDD必須**。
- **ボイラープレート (Standard)**: UIコンポーネント、基本APIルーティング、DB接続部。 -> **AI直接生成**。

## 2. 開発プロセス (Implementation)
1. **Critical TDD**:
   - `requirements-wizard` からコア機能のテストを先に生成。
   - テストをパスする実装を AI が行い、信頼性を確定。
2. **AI-Direct Scaffolding**:
   - 残りの機能を AI が一気に実装。
3. **Comprehensive Coverage**:
   - `test-suite-architect` が実装された全コードを読み取り、不足しているテストを後追いで自動生成（バックフィル）。
   - `test-genie` で実行し、**最終的なカバレッジ 90% 以上**を保証。

## 3. 最適化 (Optimize)
- `refactoring-engine` でコードを統合・洗練。
- `asset-token-economist` を使い、重複するテストコードや冗長なプロンプトを整理。
