# 要件ドキュメント

## はじめに

本ドキュメントは、Kyberionプロジェクトのテストカバレッジ拡充を目的とした要件を定義します。

現在のスコープは以下の2領域に絞られています：

1. **テストなしアクチュエータへのテスト追加**（android-actuator, code-actuator, file-actuator, ios-actuator, network-actuator）
2. **共有パッケージ5つへのテスト追加**（shared-business, shared-media, shared-nerve, shared-network, shared-vision）

既に実装済みの項目（Vitest設定・CI/CD・カバレッジ閾値チェック・ビルドサイズ測定・ESLint準拠チェック）は本ドキュメントのスコープ外です。

## 用語集

- **Actuator**: Kyberionエコシステムにおける機能実装モジュール。`libs/actuators/` 配下に配置される。各アクチュエータは `handleAction()` を公開エントリポイントとして持つ。
- **Pipeline_Engine**: アクチュエータ内部のパイプライン実行エンジン。`steps` 配列を受け取り `{ status, results, context }` を返す。
- **Shared_Package**: 複数のアクチュエータで共有されるライブラリパッケージ。`libs/shared-*/` 配下に配置される。
- **Test_Coverage_System**: Vitestとv8 providerによるテストカバレッジ測定・報告システム。
- **Property_Test_Runner**: fast-checkライブラリを使用したプロパティベーステスト実行環境。
- **ExcelDesignProtocol**: `shared-media` が定義するExcelデザイン情報の中間表現フォーマット。
- **ReflexEngine**: `shared-nerve` が提供する自律反射エンジン。刺激（NerveMessage）とReflexADFを照合して反応を実行する。
- **McpActionRequest**: `shared-network` が定義するMCPクライアント操作リクエスト型。

## 要件

### 要件1: テストなしアクチュエータへのテスト追加

**ユーザーストーリー:** 開発者として、テストが存在しない5つのアクチュエータ（android-actuator, code-actuator, file-actuator, ios-actuator, network-actuator）に対してテストを追加したい。これにより、リファクタリングや機能追加時の回帰バグを防止できる。

#### 受入基準

1. THE Test_Coverage_System SHALL android-actuator, code-actuator, file-actuator, ios-actuator, network-actuatorの各アクチュエータに対してテストファイルを実行する
2. WHEN 各アクチュエータのテストが実行される場合、THE Test_Coverage_System SHALL lines・functions・branches・statementsの各カバレッジ指標で60%以上を達成する
3. WHEN `handleAction()` に有効なパイプライン入力が渡される場合、THE Pipeline_Engine SHALL `{ status: 'success' | 'failed', results: Array, context: Record<string, any> }` の形式でレスポンスを返す
4. WHEN `handleAction()` にサポートされていない `action` 値が渡される場合、THE Pipeline_Engine SHALL エラーをスローする
5. WHEN パイプラインのステップが失敗する場合、THE Pipeline_Engine SHALL 残りのステップを実行せずに `status: 'failed'` を返す
6. WHEN `max_steps` を超えるステップ数が指定される場合、THE Pipeline_Engine SHALL `[SAFETY_LIMIT]` プレフィックスを含むエラーをスローする
7. THE Property_Test_Runner SHALL パイプライン結果の構造不変条件（`status` フィールドが常に `'success'` または `'failed'` であること）をプロパティテストで検証する

### 要件2: 既存アクチュエータテストの品質向上

**ユーザーストーリー:** 開発者として、既存テストが存在する23個のアクチュエータのテスト品質を向上させたい。これにより、テストが実際のバグを検出できる信頼性を確保できる。

#### 受入基準

1. WHEN 既存アクチュエータのテストが実行される場合、THE Test_Coverage_System SHALL lines・functions・branches・statementsの各カバレッジ指標で60%以上を達成する
2. THE Test_Coverage_System SHALL 各アクチュエータの正常系（happy path）に加えてエラーケースをカバーする
3. WHEN 外部依存（ファイルシステム・ネットワーク・外部プロセス）が必要な場合、THE Test_Coverage_System SHALL モックまたはスタブを使用してテストを分離する
4. THE Test_Coverage_System SHALL 境界値（空の入力・最大値・不正な型）に対するテストケースを含む

### 要件3: 共有パッケージへのテスト追加

**ユーザーストーリー:** 開発者として、テストが存在しない5つの共有パッケージ（shared-business, shared-media, shared-nerve, shared-network, shared-vision）に対してテストを追加したい。これにより、複数のアクチュエータに影響する変更を安全に行える。

#### 受入基準

1. THE Test_Coverage_System SHALL shared-business, shared-media, shared-nerve, shared-network, shared-visionの各パッケージに対してテストファイルを実行する
2. WHEN 各共有パッケージのテストが実行される場合、THE Test_Coverage_System SHALL lines・functions・branches・statementsの各カバレッジ指標で70%以上を達成する
3. THE Test_Coverage_System SHALL 各共有パッケージの公開API（`index.ts` からエクスポートされる関数・クラス・型）をすべてカバーする

#### shared-business の受入基準

4. WHEN `calculateReinvestment(savedHours)` が呼び出される場合、THE Shared_Package SHALL `reinvestableHours` が `savedHours * 0.7` を四捨五入した値と等しいレスポンスを返す
5. WHEN `calculateReinvestment(savedHours)` が呼び出される場合、THE Shared_Package SHALL `costAvoidanceUSD` が `savedHours * 100` と等しいレスポンスを返す
6. THE Property_Test_Runner SHALL 任意の非負整数 `savedHours` に対して `reinvestableHours <= savedHours` が常に成立することをプロパティテストで検証する

#### shared-media の受入基準

7. WHEN `distillExcelDesign(filePath)` が有効なExcelファイルに対して呼び出される場合、THE Shared_Package SHALL `version`, `generatedAt`, `sheets` フィールドを含む `ExcelDesignProtocol` オブジェクトを返す
8. WHEN `generateExcelWithDesign(data, protocol, sheetName)` が呼び出される場合、THE Shared_Package SHALL `protocol.sheets` に含まれるシート名を持つワークブックを返す
9. THE Property_Test_Runner SHALL `distillExcelDesign` で取得した `ExcelDesignProtocol` を `generateExcelWithDesign` に渡した場合、シート数が保持されることをラウンドトリップ特性としてプロパティテストで検証する
10. WHEN `extractThemePalette(filePath)` が有効なExcelファイルに対して呼び出される場合、THE Shared_Package SHALL テーマインデックスをキーとするARGB文字列のマッピングを返す

#### shared-nerve の受入基準

11. WHEN `ReflexEngine` が `intent` が一致する `NerveMessage` を受け取る場合、THE Shared_Package SHALL ディスパッチャーを呼び出す
12. WHEN `ReflexEngine` が `intent` が一致しない `NerveMessage` を受け取る場合、THE Shared_Package SHALL ディスパッチャーを呼び出さない
13. WHEN `ReflexEngine` に `keyword` フィルターが設定されたReflexADFが存在し、ペイロードにキーワードが含まれない `NerveMessage` が渡される場合、THE Shared_Package SHALL ディスパッチャーを呼び出さない
14. WHEN `ReflexEngine` にディスパッチャーが設定されていない状態で `evaluate()` が呼び出される場合、THE Shared_Package SHALL エラーをスローせずに処理を完了する

#### shared-network の受入基準

15. WHEN `executeMcp` が `action: 'call_tool'` で `name` フィールドなしに呼び出される場合、THE Shared_Package SHALL `"Tool name is required"` を含むエラーをスローする
16. WHEN `executeMcp` が `action: 'list_tools'` で呼び出される場合、THE Shared_Package SHALL MCPクライアントの `listTools()` を呼び出す

#### shared-vision の受入基準

17. WHEN `consultVision` が有効な `TieBreakOption` 配列と選択インデックスで呼び出される場合、THE Shared_Package SHALL 選択されたオプションを返す
18. WHEN `consultVision` に空の `options` 配列が渡される場合、THE Shared_Package SHALL エラーを適切に処理する

### 要件4: プロパティベーステストの導入

**ユーザーストーリー:** 開発者として、fast-checkを使用したプロパティベーステストを導入したい。これにより、手動では発見しにくいエッジケースを自動的に検出できる。

#### 受入基準

1. THE Property_Test_Runner SHALL fast-checkライブラリを使用してプロパティテストを実行する
2. THE Property_Test_Runner SHALL 各プロパティテストで最低100ケースの入力を生成して検証する
3. WHEN プロパティテストが失敗する場合、THE Property_Test_Runner SHALL 失敗を引き起こした最小の反例（counterexample）を出力する
4. THE Property_Test_Runner SHALL `shared-business` の `calculateReinvestment` に対して以下の不変条件をプロパティテストで検証する：
   - 任意の非負数 `n` に対して `reinvestableHours(n) <= n` が成立する
   - 任意の非負数 `n` に対して `costAvoidanceUSD(n) = n * 100` が成立する
5. THE Property_Test_Runner SHALL パイプライン実行結果の構造不変条件（`status` が `'success'` または `'failed'` のいずれかであること）をプロパティテストで検証する
6. THE Property_Test_Runner SHALL `ExcelDesignProtocol` のラウンドトリップ特性（distill → generate → シート数保持）をプロパティテストで検証する

### 要件5: カバレッジ目標の達成と継続的な維持

**ユーザーストーリー:** 開発者として、テストカバレッジの目標値を明確にし、継続的に維持したい。これにより、テスト品質の退行を防止できる。

#### 受入基準

1. WHEN `pnpm test:coverage` が実行される場合、THE Test_Coverage_System SHALL アクチュエータ全体でlines・functions・branches・statementsの各指標が60%以上であることを検証する
2. WHEN `pnpm test:coverage` が実行される場合、THE Test_Coverage_System SHALL 共有パッケージ全体でlines・functions・branches・statementsの各指標が70%以上であることを検証する
3. WHEN カバレッジが設定済み閾値（`vitest.config.mts` の `coverage.lines/functions/branches/statements: 60`）を下回る場合、THE Test_Coverage_System SHALL テスト実行を非ゼロの終了コードで終了する
4. THE Test_Coverage_System SHALL カバレッジレポートをHTML形式（`./coverage/` ディレクトリ）で出力する
5. THE Test_Coverage_System SHALL カバレッジレポートをJSON形式（`./coverage/coverage-summary.json`）で出力する（CIでのPRコメント投稿に使用）
