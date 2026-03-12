# Test Utilities

このディレクトリには、Kyberionプロジェクトのテスト作成を支援するユーティリティが含まれています。

## 概要

テストユーティリティは3つの主要コンポーネントで構成されています：

1. **Mock Factory** - モックオブジェクトの作成
2. **Fixture Generator** - テストデータの生成
3. **Assertion Extensions** - カスタムアサーション

## 使用方法

### Mock Factory

アクチュエータ、ファイルシステム、ネットワークのモックを作成します。

```typescript
import { createMockActuator, createMockFileSystem, createMockNetwork } from './utils';

// アクチュエータのモック
const mockActuator = createMockActuator('file-actuator');
await mockActuator.execute();

// ファイルシステムのモック
const mockFs = createMockFileSystem();
const content = await mockFs.readFile('test.txt');

// ネットワークのモック
const mockNetwork = createMockNetwork();
const response = await mockNetwork.fetch('https://example.com');
```

### Fixture Generator

ADF、ミッションコントラクト、テストデータを生成します。

```typescript
import { generateADF, generateMissionContract, generateTestData } from './utils';

// ADF（Agentic Data Format）の生成
const adf = generateADF({
  skill: 'file-actuator',
  action: 'read',
  tier: 'public',
});

// ミッションコントラクトの生成
const contract = generateMissionContract({
  skill: 'test-skill',
  risk_level: 2,
  require_sudo: true,
});

// スキーマベースのテストデータ生成
const data = generateTestData<{ name: string; age: number }>({
  name: 'string',
  age: 'number',
});
```

### Assertion Extensions

カスタムアサーションを使用してADFスキーマ、ミッション状態、GEMINI準拠を検証します。

```typescript
import './utils/assertion-extensions';

// ADFスキーマの検証
expect(adfObject).toMatchADFSchema();

// ミッション状態の検証
expect(missionState).toHaveValidMissionState();

// GEMINI準拠の検証
expect(codeObject).toBeGEMINICompliant();
```

## ファイル構成

- `mock-factory.ts` - モックヘルパー
- `fixture-generator.ts` - テストデータ生成機能
- `assertion-extensions.ts` - カスタムアサーション
- `index.ts` - 統合エクスポート
- `test-utilities.test.ts` - ユーティリティのテスト

## 要件

このユーティリティは要件9.5（テストインフラストラクチャの改善）を満たします。
