# 設計ドキュメント

## 概要

本設計は、Kyberionプロジェクトの品質向上を段階的に実現するための技術的アプローチを定義します。12の要件を6つのフェーズに分けて実装し、テストカバレッジの向上、型安全性の強化、コード品質の改善、モノレポ構造の整理を行います。

### 設計目標

1. **段階的な改善**: 既存のコードベースを破壊せず、段階的に品質を向上させる
2. **自動化の推進**: CI/CDパイプラインを活用し、品質チェックを自動化する
3. **可視化と追跡**: メトリクスを可視化し、改善の進捗を追跡可能にする
4. **開発者体験の向上**: ツールとプロセスを改善し、開発効率を高める

### 技術スタック

- **テストフレームワーク**: Vitest（既存）
- **カバレッジツール**: c8（既存）
- **型チェック**: TypeScript 5.9.3（既存）
- **リンター**: ESLint 9.0（既存）
- **CI/CD**: GitHub Actions
- **モノレポ管理**: pnpm workspaces（既存）

## アーキテクチャ

### システム構成

本設計は、以下の主要コンポーネントで構成されます：

```
┌─────────────────────────────────────────────────────────────┐
│                     CI/CD Pipeline                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Test    │  │   Type   │  │  Lint    │  │ Coverage │  │
│  │  Runner  │  │  Check   │  │  Check   │  │  Report  │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   Quality Infrastructure                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Vitest     │  │  TypeScript  │  │    ESLint    │     │
│  │   Config     │  │   Configs    │  │    Config    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Monorepo Structure                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │Actuators │  │  Shared  │  │ Scripts  │  │   Core   │  │
│  │  (14)    │  │Packages  │  │          │  │          │  │
│  │          │  │   (5)    │  │          │  │          │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### フェーズ別アーキテクチャ

#### フェーズ1: 基盤整備

テストインフラとCI/CDパイプラインを強化し、品質改善の基盤を構築します。

```
┌─────────────────────────────────────────┐
│      Enhanced Test Infrastructure       │
│  ┌─────────────────────────────────┐   │
│  │  Vitest Configuration           │   │
│  │  - Parallel execution           │   │
│  │  - Smart caching                │   │
│  │  - Coverage reporting           │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  Test Utilities                 │   │
│  │  - Mock helpers                 │   │
│  │  - Fixture generators           │   │
│  │  - Assertion extensions         │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│      GitHub Actions Workflows           │
│  ┌─────────────────────────────────┐   │
│  │  PR Validation                  │   │
│  │  - Run all tests                │   │
│  │  - Type checking                │   │
│  │  - Lint checking                │   │
│  │  - Coverage reporting           │   │
│  │  - Security scanning            │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

#### フェーズ2: テスト拡充

アクチュエータ、共有パッケージ、スクリプトのテストカバレッジを拡充します。

```
┌─────────────────────────────────────────┐
│         Test Coverage Expansion         │
│  ┌─────────────────────────────────┐   │
│  │  Actuator Tests (14 modules)    │   │
│  │  - Unit tests (60% coverage)    │   │
│  │  - Integration tests            │   │
│  │  - API contract tests           │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  Shared Package Tests (5 pkgs)  │   │
│  │  - Unit tests (70% coverage)    │   │
│  │  - Cross-package tests          │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  Script Tests (4 critical)      │   │
│  │  - Unit tests (50% coverage)    │   │
│  │  - Error path tests             │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

#### フェーズ3: 型安全性向上

TypeScriptの厳格モードへ段階的に移行します。

```
┌─────────────────────────────────────────┐
│      TypeScript Migration Strategy      │
│  ┌─────────────────────────────────┐   │
│  │  tsconfig.strict.json           │   │
│  │  - strict: true                 │   │
│  │  - noImplicitAny: true          │   │
│  │  - strictNullChecks: true       │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  Migration Tracker              │   │
│  │  - .kiro/migration/             │   │
│  │    - typescript-strict.json     │   │
│  │    - completed-files.json       │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  Migration Rules                │   │
│  │  - New files: strict mode       │   │
│  │  - Modified files: gradual      │   │
│  │  - Legacy files: tracked        │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

#### フェーズ4: コード品質向上

ESLintルールを段階的に有効化し、GEMINI準拠を強化します。

```
┌─────────────────────────────────────────┐
│       ESLint Rule Activation            │
│  ┌─────────────────────────────────┐   │
│  │  Phase 1: Warnings              │   │
│  │  - no-explicit-any: warn        │   │
│  │  - no-unused-vars: warn         │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  Phase 2: Errors                │   │
│  │  - All rules: error             │   │
│  │  - New files: strict            │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │  GEMINI Compliance              │   │
│  │  - no-restricted-imports        │   │
│  │  - custom rules for ADF         │   │
│  │  - mission_controller checks    │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## コンポーネントとインターフェース

### 1. テストインフラストラクチャ

#### TestRunner

テストの実行とカバレッジ測定を管理します。

```typescript
interface TestRunnerConfig {
  parallel: boolean;
  cache: boolean;
  coverage: {
    enabled: boolean;
    threshold: {
      lines: number;
      functions: number;
      branches: number;
      statements: number;
    };
    reporter: string[];
  };
  timeout: number;
}

interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  coverage: CoverageReport;
}

interface CoverageReport {
  lines: { total: number; covered: number; pct: number };
  functions: { total: number; covered: number; pct: number };
  branches: { total: number; covered: number; pct: number };
  statements: { total: number; covered: number; pct: number };
}
```

#### TestUtilities

テスト作成を支援するユーティリティを提供します。

```typescript
interface MockFactory {
  createMockActuator(type: string): MockActuator;
  createMockFileSystem(): MockFileSystem;
  createMockNetwork(): MockNetwork;
}

interface FixtureGenerator {
  generateADF(options?: ADFOptions): ActuatorDescriptionFormat;
  generateMissionContract(options?: MissionOptions): MissionContract;
  generateTestData<T>(schema: Schema): T;
}

interface AssertionExtensions {
  toMatchADFSchema(received: unknown): void;
  toHaveValidMissionState(received: MissionState): void;
  toBeValidGEMINICompliant(received: unknown): void;
}
```

### 2. CI/CDパイプライン

#### GitHubActionsWorkflow

品質チェックを自動化するワークフローを定義します。

```typescript
interface WorkflowConfig {
  name: string;
  triggers: {
    pullRequest: string[];
    push: string[];
  };
  jobs: Job[];
}

interface Job {
  name: string;
  runsOn: string;
  steps: Step[];
}

interface Step {
  name: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface QualityGate {
  testCoverage: {
    minimum: number;
    enforced: boolean;
  };
  typeErrors: {
    maximum: number;
    enforced: boolean;
  };
  lintWarnings: {
    maximum: number;
    enforced: boolean;
  };
}
```

### 3. TypeScript移行管理

#### MigrationTracker

TypeScript厳格モードへの移行を追跡します。

```typescript
interface MigrationTracker {
  trackFile(filePath: string, status: MigrationStatus): void;
  getProgress(): MigrationProgress;
  markCompleted(filePath: string): void;
  generateReport(): MigrationReport;
}

interface MigrationStatus {
  filePath: string;
  currentMode: 'loose' | 'partial' | 'strict';
  targetMode: 'strict';
  errors: TypeScriptError[];
  lastModified: Date;
}

interface MigrationProgress {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  percentage: number;
}

interface MigrationReport {
  summary: MigrationProgress;
  filesByStatus: Record<string, string[]>;
  topErrors: Array<{ message: string; count: number }>;
  estimatedEffort: string;
}
```

### 4. ESLintルール管理

#### LintRuleManager

ESLintルールの段階的な有効化を管理します。

```typescript
interface LintRuleManager {
  activateRule(ruleName: string, level: 'warn' | 'error'): void;
  upgradeRule(ruleName: string, from: 'warn', to: 'error'): void;
  getRuleStatus(ruleName: string): RuleStatus;
  generateMigrationPlan(): RuleMigrationPlan;
}

interface RuleStatus {
  name: string;
  level: 'off' | 'warn' | 'error';
  violations: number;
  affectedFiles: string[];
}

interface RuleMigrationPlan {
  phase: number;
  rules: Array<{
    name: string;
    currentLevel: string;
    targetLevel: string;
    estimatedViolations: number;
  }>;
}
```

### 5. メトリクス収集と可視化

#### MetricsCollector

品質メトリクスを収集し、可視化します。

```typescript
interface MetricsCollector {
  collectCoverage(): CoverageMetrics;
  collectTypeErrors(): TypeErrorMetrics;
  collectLintWarnings(): LintMetrics;
  collectComplexity(): ComplexityMetrics;
  generateDashboard(): Dashboard;
}

interface CoverageMetrics {
  timestamp: Date;
  overall: number;
  byPackage: Record<string, number>;
  trend: Array<{ date: Date; coverage: number }>;
}

interface TypeErrorMetrics {
  timestamp: Date;
  total: number;
  byFile: Record<string, number>;
  trend: Array<{ date: Date; errors: number }>;
}

interface LintMetrics {
  timestamp: Date;
  warnings: number;
  errors: number;
  byRule: Record<string, number>;
  trend: Array<{ date: Date; warnings: number; errors: number }>;
}

interface ComplexityMetrics {
  timestamp: Date;
  averageCyclomaticComplexity: number;
  highComplexityFiles: Array<{ file: string; complexity: number }>;
}

interface Dashboard {
  summary: {
    coverage: number;
    typeErrors: number;
    lintWarnings: number;
    complexity: number;
  };
  trends: {
    coverage: TrendData[];
    typeErrors: TrendData[];
    lintWarnings: TrendData[];
  };
  alerts: Alert[];
}

interface TrendData {
  date: Date;
  value: number;
}

interface Alert {
  severity: 'info' | 'warning' | 'error';
  message: string;
  timestamp: Date;
}
```

## データモデル

### 移行管理データ

#### TypeScript移行状態

```typescript
// .kiro/migration/typescript-strict.json
interface TypeScriptMigrationState {
  version: string;
  lastUpdated: Date;
  files: {
    completed: string[];
    inProgress: string[];
    pending: string[];
  };
  statistics: {
    totalFiles: number;
    completedFiles: number;
    completionPercentage: number;
  };
  errors: {
    [filePath: string]: {
      count: number;
      messages: string[];
    };
  };
}
```

#### ESLint移行状態

```typescript
// .kiro/migration/eslint-rules.json
interface ESLintMigrationState {
  version: string;
  lastUpdated: Date;
  rules: {
    [ruleName: string]: {
      level: 'off' | 'warn' | 'error';
      activatedAt?: Date;
      upgradedAt?: Date;
      violations: number;
    };
  };
  files: {
    compliant: string[];
    warnings: string[];
    errors: string[];
  };
}
```

### テストカバレッジデータ

```typescript
// coverage/coverage-summary.json (c8 format)
interface CoverageSummary {
  total: {
    lines: { total: number; covered: number; skipped: number; pct: number };
    statements: { total: number; covered: number; skipped: number; pct: number };
    functions: { total: number; covered: number; skipped: number; pct: number };
    branches: { total: number; covered: number; skipped: number; pct: number };
  };
  [filePath: string]: {
    lines: { total: number; covered: number; skipped: number; pct: number };
    statements: { total: number; covered: number; skipped: number; pct: number };
    functions: { total: number; covered: number; skipped: number; pct: number };
    branches: { total: number; covered: number; skipped: number; pct: number };
  };
}
```

### メトリクス履歴データ

```typescript
// .kiro/metrics/history.json
interface MetricsHistory {
  version: string;
  entries: MetricsEntry[];
}

interface MetricsEntry {
  timestamp: Date;
  commit: string;
  coverage: {
    overall: number;
    actuators: number;
    sharedPackages: number;
    scripts: number;
  };
  typeErrors: number;
  lintWarnings: number;
  lintErrors: number;
  complexity: {
    average: number;
    max: number;
  };
}
```

## Correctness Properties

_プロパティとは、システムのすべての有効な実行において真であるべき特性や振る舞いのことです。本質的には、システムが何をすべきかについての形式的な記述です。プロパティは、人間が読める仕様と機械が検証可能な正確性の保証との橋渡しとなります。_

### Property 1: 公開APIカバレッジの完全性

*任意の*パッケージ（アクチュエータ、共有パッケージ、スクリプト）について、そのテストスイートは、パッケージが公開するすべてのAPIエントリーポイントをカバーしなければならない

**Validates: Requirements 1.4, 2.3**

### Property 2: 実行パスカバレッジの網羅性

*任意の*スクリプトについて、そのテストスイートは、主要な実行パス（正常系とエラー系の両方）をカバーしなければならない

**Validates: Requirements 3.3, 3.4**

### Property 3: 依存関係変更時のテスト実行

*任意の*共有パッケージが変更された場合、そのパッケージに依存するすべてのアクチュエータのテストが実行されなければならない

**Validates: Requirements 2.4**

### Property 4: 移行ファイルの自動追跡

*任意の*ファイルについて、TypeScript厳格モードへの移行状態（pending、inProgress、completed）が移行トラッカーによって正確に記録され、状態遷移時に自動的に更新されなければならない

**Validates: Requirements 4.4, 12.2**

### Property 5: パッケージメタデータの完全性

*任意の*パッケージ（libs/actuators/\*、libs/shared-\*）について、そのpackage.jsonは、main、types、exportsフィールドを含み、すべての依存関係を明示的に宣言しなければならない

**Validates: Requirements 6.2, 6.3**

### Property 6: インポートパスの自動更新

*任意の*ファイル移動操作について、そのファイルをインポートしているすべてのファイルのインポートパスが自動的に更新され、ビルドエラーが発生しないようにしなければならない

**Validates: Requirements 6.4**

### Property 7: README言語の一貫性

*任意の*パッケージについて、そのREADME.mdファイルは日本語で記述されていなければならない

**Validates: Requirements 8.1**

## エラーハンドリング

### テスト実行エラー

#### カバレッジ閾値未達

```typescript
class CoverageThresholdError extends Error {
  constructor(
    public packageName: string,
    public actual: number,
    public expected: number
  ) {
    super(`Coverage ${actual}% is below threshold ${expected}% for ${packageName}`);
  }
}
```

**対処方法**:

1. カバレッジレポートを確認し、未カバーのコードを特定
2. 不足しているテストケースを追加
3. 必要に応じて閾値を一時的に調整（ただし、段階的に引き上げる計画を立てる）

#### テスト実行タイムアウト

```typescript
class TestTimeoutError extends Error {
  constructor(
    public testName: string,
    public duration: number,
    public timeout: number
  ) {
    super(`Test "${testName}" exceeded timeout: ${duration}ms > ${timeout}ms`);
  }
}
```

**対処方法**:

1. テストのパフォーマンスを分析
2. 不要な待機時間を削減
3. モックを使用して外部依存を排除
4. 必要に応じてタイムアウト値を調整

### TypeScript移行エラー

#### 型エラーの大量発生

```typescript
class MigrationOverloadError extends Error {
  constructor(
    public filePath: string,
    public errorCount: number
  ) {
    super(`File ${filePath} has ${errorCount} type errors, exceeding migration threshold`);
  }
}
```

**対処方法**:

1. ファイルを小さな単位に分割
2. 段階的に型を追加（any → unknown → 具体的な型）
3. 一時的に@ts-ignoreを使用し、TODOコメントで追跡
4. 移行計画を見直し、優先順位を調整

#### 循環依存の検出

```typescript
class CircularDependencyError extends Error {
  constructor(public cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`);
  }
}
```

**対処方法**:

1. 依存関係グラフを可視化
2. 共通の依存を抽出して新しいパッケージに分離
3. インターフェースを使用して依存を逆転
4. 必要に応じてアーキテクチャを再設計

### ESLintエラー

#### ルール違反の大量発生

```typescript
class LintViolationOverloadError extends Error {
  constructor(
    public ruleName: string,
    public violationCount: number
  ) {
    super(`Rule "${ruleName}" has ${violationCount} violations, exceeding activation threshold`);
  }
}
```

**対処方法**:

1. 自動修正可能な違反を`eslint --fix`で修正
2. 残りの違反を優先順位付け
3. 段階的に修正（ファイル単位またはディレクトリ単位）
4. 必要に応じてルールレベルを一時的にwarnに戻す

#### GEMINI準拠違反

```typescript
class GEMINIViolationError extends Error {
  constructor(
    public filePath: string,
    public violation: string,
    public suggestion: string
  ) {
    super(`GEMINI violation in ${filePath}: ${violation}. Suggestion: ${suggestion}`);
  }
}
```

**対処方法**:

1. 違反箇所を特定
2. 推奨される代替実装を適用
3. 必要に応じてAGENTS.mdを参照
4. テストを実行して動作を確認

### CI/CDエラー

#### ワークフロー実行失敗

```typescript
class WorkflowFailureError extends Error {
  constructor(
    public workflowName: string,
    public step: string,
    public reason: string
  ) {
    super(`Workflow "${workflowName}" failed at step "${step}": ${reason}`);
  }
}
```

**対処方法**:

1. GitHub Actionsのログを確認
2. ローカル環境で再現
3. 失敗したステップを修正
4. 必要に応じてワークフロー設定を調整

#### カバレッジレポート投稿失敗

```typescript
class CoverageReportError extends Error {
  constructor(
    public prNumber: number,
    public reason: string
  ) {
    super(`Failed to post coverage report to PR #${prNumber}: ${reason}`);
  }
}
```

**対処方法**:

1. GitHub APIトークンの権限を確認
2. ネットワーク接続を確認
3. レポート形式を検証
4. 必要に応じて手動でレポートを投稿

## テスト戦略

### デュアルテストアプローチ

本プロジェクトでは、ユニットテストとプロパティベーステストの両方を活用します：

- **ユニットテスト**: 具体的な例、エッジケース、エラー条件を検証
- **プロパティベーステスト**: すべての入力に対する普遍的なプロパティを検証

両者は補完的であり、包括的なカバレッジに必要です。ユニットテストは具体的なバグを捕捉し、プロパティテストは一般的な正確性を検証します。

### ユニットテストのバランス

ユニットテストは以下に焦点を当てます：

- 正しい動作を示す具体的な例
- コンポーネント間の統合ポイント
- エッジケースとエラー条件

プロパティベーステストがランダム化を通じて多くの入力をカバーするため、過度にユニットテストを書くことは避けます。

### プロパティベーステストの設定

- **テストライブラリ**: fast-check（TypeScript/JavaScript用）
- **最小イテレーション数**: 100回（ランダム化のため）
- **タグ形式**: `Feature: project-quality-improvement, Property {number}: {property_text}`
- 各正確性プロパティは、単一のプロパティベーステストで実装されます

### テストカバレッジ目標

#### フェーズ2: テスト拡充

| パッケージタイプ      | 目標カバレッジ | 優先度 |
| --------------------- | -------------- | ------ |
| アクチュエータ (14個) | 60%            | 高     |
| 共有パッケージ (5個)  | 70%            | 高     |
| 重要スクリプト (4個)  | 50%            | 中     |

#### テストタイプ別の配分

- **ユニットテスト**: 70%（具体的な機能の検証）
- **統合テスト**: 20%（コンポーネント間の連携）
- **プロパティベーステスト**: 10%（普遍的なプロパティの検証）

### テストの実装順序

#### フェーズ1: 基盤整備（1-2週間）

1. Vitest設定の強化（並列実行、キャッシング）
2. テストユーティリティの作成（モック、フィクスチャ）
3. GitHub Actionsワークフローの作成
4. カバレッジレポート機能の実装

#### フェーズ2: テスト拡充（4-6週間）

1. アクチュエータのテスト作成
   - 各アクチュエータの公開APIをカバー
   - 主要な実行パスをテスト
   - エラーハンドリングをテスト
2. 共有パッケージのテスト作成
   - 各パッケージの公開APIをカバー
   - クロスパッケージの統合テスト
3. スクリプトのテスト作成
   - 主要な実行パスをカバー
   - エラーケースをテスト

#### フェーズ3: 型安全性向上（3-4週間）

1. tsconfig.strict.jsonの作成
2. 移行トラッカーの実装
3. 新規ファイルへのstrict適用
4. 既存ファイルの段階的移行

#### フェーズ4: コード品質向上（3-4週間）

1. ESLintルールの段階的有効化
2. GEMINI準拠カスタムルールの作成
3. 既存コードの修正
4. ルールレベルのerrorへの昇格

#### フェーズ5: 構造改善（2-3週間）

1. libs/core/のファイル整理
2. package.jsonの更新
3. 依存関係の明示化
4. 循環依存の解消

#### フェーズ6: 可視化（1-2週間）

1. メトリクス収集の実装
2. ダッシュボードの作成
3. アラート機能の実装
4. 推移グラフの生成

### プロパティベーステストの例

#### Property 1: 公開APIカバレッジの完全性

```typescript
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { getPackageExports, getCoverageReport } from './test-utils';

// Feature: project-quality-improvement, Property 1: 公開APIカバレッジの完全性
describe('Property 1: Public API Coverage Completeness', () => {
  it('should cover all public API entry points for any package', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'blockchain-actuator',
          'browser-actuator',
          'code-actuator',
          // ... 他のアクチュエータ
          'shared-media',
          'shared-vision'
          // ... 他の共有パッケージ
        ),
        async (packageName) => {
          const exports = await getPackageExports(packageName);
          const coverage = await getCoverageReport(packageName);

          // すべての公開APIがカバレッジレポートに含まれているか確認
          for (const exportName of exports) {
            expect(coverage.functions).toContain(exportName);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

#### Property 5: パッケージメタデータの完全性

```typescript
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { readPackageJson } from './test-utils';

// Feature: project-quality-improvement, Property 5: パッケージメタデータの完全性
describe('Property 5: Package Metadata Completeness', () => {
  it('should have required fields in package.json for any package', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'libs/actuators/blockchain-actuator',
          'libs/actuators/browser-actuator',
          // ... 他のアクチュエータ
          'libs/shared-media',
          'libs/shared-vision'
          // ... 他の共有パッケージ
        ),
        async (packagePath) => {
          const pkg = await readPackageJson(packagePath);

          // 必須フィールドの存在確認
          expect(pkg).toHaveProperty('main');
          expect(pkg).toHaveProperty('types');
          expect(pkg).toHaveProperty('exports');

          // 依存関係の明示的宣言確認
          if (pkg.dependencies || pkg.devDependencies) {
            expect(
              Object.keys(pkg.dependencies || {}).length +
                Object.keys(pkg.devDependencies || {}).length
            ).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

### ユニットテストの例

#### カバレッジ閾値の検証

```typescript
import { describe, it, expect } from 'vitest';
import { runTests, getCoverageReport } from './test-utils';

describe('Coverage Threshold Validation', () => {
  it('should achieve 60% coverage for actuators', async () => {
    const actuators = [
      'blockchain-actuator',
      'browser-actuator',
      'code-actuator',
      // ... 他のアクチュエータ
    ];

    for (const actuator of actuators) {
      const coverage = await getCoverageReport(actuator);
      expect(coverage.lines.pct).toBeGreaterThanOrEqual(60);
    }
  });

  it('should achieve 70% coverage for shared packages', async () => {
    const sharedPackages = [
      'shared-media',
      'shared-vision',
      'shared-network',
      'shared-business',
      'shared-nerve',
    ];

    for (const pkg of sharedPackages) {
      const coverage = await getCoverageReport(pkg);
      expect(coverage.lines.pct).toBeGreaterThanOrEqual(70);
    }
  });
});
```

#### TypeScript移行トラッカーのテスト

```typescript
import { describe, it, expect } from 'vitest';
import { MigrationTracker } from '../src/migration-tracker';

describe('MigrationTracker', () => {
  it('should track file migration status', () => {
    const tracker = new MigrationTracker();

    tracker.trackFile('src/example.ts', {
      filePath: 'src/example.ts',
      currentMode: 'loose',
      targetMode: 'strict',
      errors: [],
      lastModified: new Date(),
    });

    const progress = tracker.getProgress();
    expect(progress.pending).toBe(1);

    tracker.markCompleted('src/example.ts');
    const updatedProgress = tracker.getProgress();
    expect(updatedProgress.completed).toBe(1);
    expect(updatedProgress.pending).toBe(0);
  });

  it('should generate migration report', () => {
    const tracker = new MigrationTracker();

    tracker.trackFile('src/file1.ts', {
      filePath: 'src/file1.ts',
      currentMode: 'loose',
      targetMode: 'strict',
      errors: [],
      lastModified: new Date(),
    });

    tracker.trackFile('src/file2.ts', {
      filePath: 'src/file2.ts',
      currentMode: 'partial',
      targetMode: 'strict',
      errors: [],
      lastModified: new Date(),
    });

    tracker.markCompleted('src/file1.ts');

    const report = tracker.generateReport();
    expect(report.summary.total).toBe(2);
    expect(report.summary.completed).toBe(1);
    expect(report.summary.percentage).toBe(50);
  });
});
```

#### ESLintルール管理のテスト

```typescript
import { describe, it, expect } from 'vitest';
import { LintRuleManager } from '../src/lint-rule-manager';

describe('LintRuleManager', () => {
  it('should activate rule at warn level', () => {
    const manager = new LintRuleManager();

    manager.activateRule('@typescript-eslint/no-explicit-any', 'warn');

    const status = manager.getRuleStatus('@typescript-eslint/no-explicit-any');
    expect(status.level).toBe('warn');
  });

  it('should upgrade rule from warn to error', () => {
    const manager = new LintRuleManager();

    manager.activateRule('@typescript-eslint/no-explicit-any', 'warn');
    manager.upgradeRule('@typescript-eslint/no-explicit-any', 'warn', 'error');

    const status = manager.getRuleStatus('@typescript-eslint/no-explicit-any');
    expect(status.level).toBe('error');
  });

  it('should generate migration plan', () => {
    const manager = new LintRuleManager();

    manager.activateRule('@typescript-eslint/no-explicit-any', 'warn');
    manager.activateRule('@typescript-eslint/no-unused-vars', 'warn');

    const plan = manager.generateMigrationPlan();
    expect(plan.rules).toHaveLength(2);
    expect(plan.rules[0].currentLevel).toBe('warn');
    expect(plan.rules[0].targetLevel).toBe('error');
  });
});
```

### CI/CD統合テスト

```typescript
import { describe, it, expect } from 'vitest';
import { parseWorkflowFile } from './test-utils';

describe('GitHub Actions Workflow', () => {
  it('should include test step in PR workflow', async () => {
    const workflow = await parseWorkflowFile('.github/workflows/pr-validation.yml');

    const testStep = workflow.jobs.test.steps.find((step) => step.name === 'Run tests');

    expect(testStep).toBeDefined();
    expect(testStep.run).toContain('vitest run');
  });

  it('should include coverage reporting step', async () => {
    const workflow = await parseWorkflowFile('.github/workflows/pr-validation.yml');

    const coverageStep = workflow.jobs.test.steps.find((step) => step.name === 'Report coverage');

    expect(coverageStep).toBeDefined();
  });

  it('should include type checking step', async () => {
    const workflow = await parseWorkflowFile('.github/workflows/pr-validation.yml');

    const typeCheckStep = workflow.jobs.test.steps.find((step) => step.name === 'Type check');

    expect(typeCheckStep).toBeDefined();
    expect(typeCheckStep.run).toContain('tsc --noEmit');
  });
});
```

## 実装の詳細

### フェーズ1: 基盤整備

#### 1.1 Vitest設定の強化

**ファイル**: `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: [
      '**/src/**/*.test.ts',
      '**/src/**/*.test.js',
      'libs/core/**/*.test.ts',
      'libs/actuators/**/*.test.ts',
      'libs/shared-*/**/*.test.ts',
      'scripts/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/vault/**',
      '**/active/**',
      '**/docs/**',
      '**/knowledge/**',
    ],
    // 並列実行を有効化
    threads: true,
    maxThreads: 4,
    minThreads: 1,

    // キャッシングを有効化
    cache: {
      dir: 'node_modules/.vitest',
    },

    // カバレッジ設定
    coverage: {
      provider: 'c8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      exclude: ['node_modules/', 'dist/', '**/*.test.ts', '**/*.d.ts'],
      // 閾値設定
      lines: 60,
      functions: 60,
      branches: 60,
      statements: 60,
    },

    // タイムアウト設定
    testTimeout: 10000,
    hookTimeout: 10000,

    alias: [
      { find: /^@agent\/core\/(.*)$/, replacement: path.resolve(__dirname, './libs/core/$1') },
      { find: '@agent/core', replacement: path.resolve(__dirname, './libs/core/index.ts') },
      {
        find: '@agent/shared-media',
        replacement: path.resolve(__dirname, './libs/shared-media/src/index.ts'),
      },
      {
        find: '@agent/shared-vision',
        replacement: path.resolve(__dirname, './libs/shared-vision/src/index.ts'),
      },
      {
        find: '@agent/shared-network',
        replacement: path.resolve(__dirname, './libs/shared-network/src/index.ts'),
      },
      {
        find: '@agent/shared-business',
        replacement: path.resolve(__dirname, './libs/shared-business/src/index.ts'),
      },
    ],
  },
});
```

#### 1.2 GitHub Actionsワークフロー

**ファイル**: `.github/workflows/pr-validation.yml`

```yaml
name: PR Validation

on:
  pull_request:
    branches: [main, develop]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type check
        run: pnpm run typecheck

      - name: Lint check
        run: pnpm run lint

      - name: Run tests
        run: pnpm run test:coverage

      - name: Check coverage threshold
        run: |
          COVERAGE=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
          if (( $(echo "$COVERAGE < 60" | bc -l) )); then
            echo "Coverage $COVERAGE% is below threshold 60%"
            exit 1
          fi

      - name: Report coverage
        uses: davelosert/vitest-coverage-report-action@v2
        with:
          json-summary-path: ./coverage/coverage-summary.json

      - name: Security scan
        run: pnpm audit --audit-level=moderate

      - name: Build
        run: pnpm run build

      - name: Measure build size
        run: |
          du -sh dist/ | tee build-size.txt
          echo "Build size: $(cat build-size.txt)"
```

### フェーズ3: 型安全性向上

#### 3.1 TypeScript厳格設定

**ファイル**: `tsconfig.strict.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": [
    // 移行完了したファイルのみを含める
  ]
}
```

#### 3.2 移行トラッカーの実装

**ファイル**: `scripts/migration-tracker.ts`

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';

interface MigrationState {
  version: string;
  lastUpdated: string;
  files: {
    completed: string[];
    inProgress: string[];
    pending: string[];
  };
  statistics: {
    totalFiles: number;
    completedFiles: number;
    completionPercentage: number;
  };
}

export class MigrationTracker {
  private statePath = '.kiro/migration/typescript-strict.json';
  private state: MigrationState;

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(content);
    } catch {
      this.state = {
        version: '1.0.0',
        lastUpdated: new Date().toISOString(),
        files: {
          completed: [],
          inProgress: [],
          pending: [],
        },
        statistics: {
          totalFiles: 0,
          completedFiles: 0,
          completionPercentage: 0,
        },
      };
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
  }

  markCompleted(filePath: string): void {
    this.state.files.pending = this.state.files.pending.filter((f) => f !== filePath);
    this.state.files.inProgress = this.state.files.inProgress.filter((f) => f !== filePath);
    if (!this.state.files.completed.includes(filePath)) {
      this.state.files.completed.push(filePath);
    }
    this.updateStatistics();
  }

  private updateStatistics(): void {
    const total =
      this.state.files.completed.length +
      this.state.files.inProgress.length +
      this.state.files.pending.length;
    this.state.statistics.totalFiles = total;
    this.state.statistics.completedFiles = this.state.files.completed.length;
    this.state.statistics.completionPercentage =
      total > 0 ? (this.state.files.completed.length / total) * 100 : 0;
    this.state.lastUpdated = new Date().toISOString();
  }
}
```

### フェーズ4: コード品質向上

#### 4.1 ESLint設定の更新

**ファイル**: `eslint.config.js`（段階的更新）

```javascript
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'coverage/**',
      'evidence/**',
      'active/**',
      'vault/**',
      '**/*.d.ts',
      '**/*.d.cts',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  // TS Config
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // フェーズ1: 警告レベルで有効化
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',

      // GEMINI準拠ルール（既存）
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'fs',
              message: 'Violation of AGENTS.md: Use @agent/core/secure-io instead.',
            },
            {
              name: 'node:fs',
              message: 'Violation of AGENTS.md: Use @agent/core/secure-io instead.',
            },
            {
              name: 'child_process',
              message: 'Violation of AGENTS.md: Use @agent/core/secure-io (safeExec) instead.',
            },
            {
              name: 'node:child_process',
              message: 'Violation of AGENTS.md: Use @agent/core/secure-io (safeExec) instead.',
            },
          ],
        },
      ],
    },
  },
];
```

### フェーズ6: メトリクス可視化

#### 6.1 メトリクス収集スクリプト

**ファイル**: `scripts/collect-metrics.ts`

```typescript
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

interface MetricsEntry {
  timestamp: string;
  commit: string;
  coverage: {
    overall: number;
    actuators: number;
    sharedPackages: number;
    scripts: number;
  };
  typeErrors: number;
  lintWarnings: number;
  lintErrors: number;
}

async function collectMetrics(): Promise<MetricsEntry> {
  // カバレッジデータの取得
  const coverageSummary = JSON.parse(await fs.readFile('coverage/coverage-summary.json', 'utf-8'));

  // TypeScriptエラー数の取得
  let typeErrors = 0;
  try {
    execSync('pnpm run typecheck', { stdio: 'pipe' });
  } catch (error: any) {
    const output = error.stdout?.toString() || '';
    const match = output.match(/Found (\d+) error/);
    typeErrors = match ? parseInt(match[1]) : 0;
  }

  // ESLint警告/エラー数の取得
  let lintWarnings = 0;
  let lintErrors = 0;
  try {
    const lintOutput = execSync('pnpm run lint', { stdio: 'pipe' }).toString();
    const warningMatch = lintOutput.match(/(\d+) warning/);
    const errorMatch = lintOutput.match(/(\d+) error/);
    lintWarnings = warningMatch ? parseInt(warningMatch[1]) : 0;
    lintErrors = errorMatch ? parseInt(errorMatch[1]) : 0;
  } catch {}

  // コミットハッシュの取得
  const commit = execSync('git rev-parse HEAD').toString().trim();

  return {
    timestamp: new Date().toISOString(),
    commit,
    coverage: {
      overall: coverageSummary.total.lines.pct,
      actuators: 0, // 個別に計算
      sharedPackages: 0, // 個別に計算
      scripts: 0, // 個別に計算
    },
    typeErrors,
    lintWarnings,
    lintErrors,
  };
}

async function saveMetrics(entry: MetricsEntry): Promise<void> {
  const historyPath = '.kiro/metrics/history.json';

  let history: { version: string; entries: MetricsEntry[] };
  try {
    history = JSON.parse(await fs.readFile(historyPath, 'utf-8'));
  } catch {
    history = { version: '1.0.0', entries: [] };
  }

  history.entries.push(entry);

  // 最新100件のみ保持
  if (history.entries.length > 100) {
    history.entries = history.entries.slice(-100);
  }

  await fs.mkdir('.kiro/metrics', { recursive: true });
  await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
}

// 実行
collectMetrics().then(saveMetrics);
```

## まとめ

本設計ドキュメントは、Kyberionプロジェクトの品質向上を段階的に実現するための包括的なアプローチを定義しました。

### 主要な設計決定

1. **段階的アプローチ**: 6つのフェーズに分けて実装し、各フェーズで具体的な成果を達成
2. **自動化優先**: CI/CDパイプラインを活用し、品質チェックを自動化
3. **デュアルテスト戦略**: ユニットテストとプロパティベーステストを組み合わせて包括的なカバレッジを実現
4. **可視化と追跡**: メトリクスを収集・可視化し、改善の進捗を追跡可能に

### 期待される成果

- **テストカバレッジ**: アクチュエータ60%、共有パッケージ70%、スクリプト50%
- **型安全性**: TypeScript厳格モードへの段階的移行
- **コード品質**: ESLintルールの有効化とGEMINI準拠の強化
- **開発効率**: 改善されたツールとプロセスによる開発サイクルの高速化

### 次のステップ

設計が承認されたら、タスクドキュメント（tasks.md）を作成し、各フェーズの具体的な実装タスクを定義します。
