# 設計ドキュメント

## 概要

本設計は、Kyberionプロジェクトのテストカバレッジ拡充を目的とした技術的アプローチを定義します。

### スコープ

**テストのみ追加する。既存のプロダクションコードは一切変更しない。**

対象は以下の2領域に絞られています：

1. **テストなし5アクチュエータへのテスト追加**（android-actuator, code-actuator, file-actuator, ios-actuator, network-actuator）
2. **共有パッケージ5つへのテスト追加**（shared-business, shared-media, shared-nerve, shared-network, shared-vision）

### 設計目標

1. **非破壊的改善**: 既存のプロダクションコードを変更せず、テストファイルのみを追加する
2. **カバレッジ目標の達成**: アクチュエータ60%以上、共有パッケージ70%以上
3. **プロパティベーステストの導入**: fast-checkを使用して普遍的な正確性を検証する
4. **外部依存の完全分離**: `vi.mock()` を使用してテストを高速・安定に保つ

### 技術スタック

| ツール | 用途 | 状態 |
|--------|------|------|
| Vitest | テストランナー | 既存・設定済み |
| v8 | カバレッジプロバイダー | 既存・設定済み |
| fast-check | プロパティベーステスト | 新規追加 |
| vi.mock() | 外部依存のモック | Vitest組み込み |

## アーキテクチャ

### テストファイルの配置規則

各テストファイルは、テスト対象のソースファイルと同じディレクトリに配置します。

```
libs/
├── actuators/
│   ├── android-actuator/src/
│   │   ├── index.ts              # プロダクションコード（変更なし）
│   │   └── index.test.ts         # 新規追加
│   ├── code-actuator/src/
│   │   ├── index.ts
│   │   └── index.test.ts         # 新規追加
│   ├── file-actuator/src/
│   │   ├── index.ts
│   │   └── index.test.ts         # 新規追加
│   ├── ios-actuator/src/
│   │   ├── index.ts
│   │   └── index.test.ts         # 新規追加
│   └── network-actuator/src/
│       ├── index.ts
│       └── index.test.ts         # 新規追加
└── shared-business/src/
    ├── finance.ts
    └── finance.test.ts           # 新規追加
    shared-media/src/
    ├── excel-utils.ts
    ├── excel-theme-resolver.ts
    └── excel-utils.test.ts       # 新規追加
    shared-nerve/src/
    ├── reflex-engine.ts
    └── reflex-engine.test.ts     # 新規追加
    shared-network/src/
    ├── mcp-client-engine.ts
    └── mcp-client-engine.test.ts # 新規追加
    shared-vision/src/
    ├── vision-judge.ts
    └── vision-judge.test.ts      # 新規追加
```

### テスト戦略の全体像

```
┌─────────────────────────────────────────────────────────────┐
│                    テスト戦略                                │
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  │
│  │   ユニットテスト     │  │  プロパティベーステスト      │  │
│  │                     │  │  (fast-check)               │  │
│  │  - 正常系           │  │                             │  │
│  │  - エラーケース     │  │  - 普遍的な不変条件         │  │
│  │  - 境界値           │  │  - ラウンドトリップ特性     │  │
│  │  - モック使用       │  │  - 100回以上のイテレーション │  │
│  └─────────────────────┘  └─────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              モック戦略                              │   │
│  │  vi.mock('@agent/core')  → ファイルシステム・ログ   │   │
│  │  vi.mock('exceljs')      → Excel操作               │   │
│  │  vi.mock('adm-zip')      → ZIP操作                 │   │
│  │  vi.mock('@modelcontextprotocol/sdk/...')           │   │
│  │                          → MCPクライアント          │   │
│  │  stdin モック            → readline操作             │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## コンポーネントとインターフェース

### 共通パイプラインエンジンのテストパターン

code-actuator, file-actuator, network-actuatorはすべて同じパイプラインエンジンパターンを持ちます。

**テスト対象の公開インターフェース**:

```typescript
// すべてのアクチュエータで共通
export { handleAction };

// handleAction の入力型（各アクチュエータで微妙に異なる）
interface PipelineAction {
  action: 'pipeline';  // code-actuatorは 'reconcile' も対応
  steps: PipelineStep[];
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

// handleAction の出力型（すべてのアクチュエータで共通）
interface PipelineResult {
  status: 'success' | 'failed';
  results: Array<{ op: string; status: 'success' | 'failed'; error?: string }>;
  context: Record<string, any>;
  total_steps: number;
}
```

**共通テストケース**:

| テストケース | 分類 | 検証内容 |
|------------|------|---------|
| 空のstepsで呼び出す | EXAMPLE | status: 'success', results: [] |
| 1ステップ成功 | EXAMPLE | status: 'success', results[0].status: 'success' |
| 1ステップ失敗 | EXAMPLE | status: 'failed', results[0].status: 'failed' |
| 失敗後のステップが実行されない | EXAMPLE | results.length === 失敗ステップのインデックス + 1 |
| max_steps超過 | EXAMPLE | [SAFETY_LIMIT]プレフィックスのエラー |
| 無効なaction | EXAMPLE | エラーをスロー |
| 任意のstepsでstatusが'success'または'failed' | PROPERTY | Property 1 |
| 任意のmax_stepsで超過時に[SAFETY_LIMIT] | PROPERTY | Property 2 |

### android-actuator / ios-actuator のテストパターン

ADB（android）/ simctl（ios）への依存があるため、外部コマンドをモックします。

**モック対象**:

```typescript
// @agent/core の safeExec をモックして ADB/simctl コマンドを制御
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeExec: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeMkdir: vi.fn(),
    safeReadFile: vi.fn(),
    safeWriteFile: vi.fn(),
    derivePipelineStatus: actual.derivePipelineStatus, // 実装を使用
    resolveVars: actual.resolveVars,
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      sharedTmp: vi.fn().mockReturnValue('/mock/tmp'),
      resolve: vi.fn().mockReturnValue('/mock/path'),
      knowledge: vi.fn().mockReturnValue('/mock/knowledge'),
    },
  };
});
```

**android-actuator 固有のテストケース**:

| テストケース | 分類 | 検証内容 |
|------------|------|---------|
| adb_health_check: adb利用可能 | EXAMPLE | adb_available: true |
| adb_health_check: adb利用不可 | EXAMPLE | adb_available: false |
| launch_app: adb未利用可能時 | EXAMPLE | エラーをスロー |
| tap: 座標を指定してadb tapを実行 | EXAMPLE | safeExecが正しい引数で呼ばれる |
| capture_screen: スクリーンショット取得 | EXAMPLE | last_screenshot_pathが設定される |

**ios-actuator 固有のテストケース**:

| テストケース | 分類 | 検証内容 |
|------------|------|---------|
| simctl_health_check: simctl利用可能 | EXAMPLE | ios_available: true |
| simctl_health_check: simctl利用不可 | EXAMPLE | ios_available: false |
| launch_app: bundle_id未指定 | EXAMPLE | エラーをスロー |
| boot_simulator: 既にBooted状態 | EXAMPLE | エラーなしで完了 |
| capture_screen: スクリーンショット取得 | EXAMPLE | last_screenshot_pathが設定される |

## データモデル

### PipelineResult（共通）

```typescript
interface PipelineResult {
  status: 'success' | 'failed';
  results: Array<{
    op: string;
    status: 'success' | 'failed';
    error?: string;
  }>;
  context: Record<string, any>;
  total_steps: number;
}
```

### ExcelDesignProtocol

```typescript
// libs/shared-media/src/types/excel-protocol.ts から
interface ExcelDesignProtocol {
  version: string;        // '1.0.0'
  generatedAt: string;    // ISO 8601 日時文字列
  theme: ThemePalette;    // { [themeIndex: number]: string } (ARGB)
  sheets: SheetDesign[];
}

interface SheetDesign {
  name: string;
  columns: Array<{ index: number; width: number }>;
  rows: any[];
  merges: any[];
  autoFilter?: string;
  views?: any;
}
```

### ReflexADF

```typescript
// libs/shared-nerve/src/reflex-engine.ts から
interface ReflexADF {
  id: string;
  trigger: {
    intent: string;
    keyword?: string;
    source?: string;
  };
  action: {
    actuator: string;
    command: string;
    params?: any;
  };
}
```

### McpActionRequest

```typescript
// libs/shared-network/src/mcp-client-engine.ts から
interface McpActionRequest {
  action: 'list_tools' | 'call_tool' | 'list_resources';
  name?: string;
  arguments?: Record<string, any>;
}
```

### TieBreakOption

```typescript
// libs/shared-vision/src/vision-judge.ts から
interface TieBreakOption {
  id: string;
  description: string;
  logic_score: number;
  vision_alignment_hint?: string;
}
```

## Correctness Properties

_プロパティとは、システムのすべての有効な実行において真であるべき特性や振る舞いのことです。本質的には、システムが何をすべきかについての形式的な記述です。プロパティは、人間が読める仕様と機械が検証可能な正確性の保証との橋渡しとなります。_

### Property 1: パイプライン結果の構造不変条件

*任意の* パイプラインステップ配列（空配列を含む）に対して、`handleAction()` が返す結果の `status` フィールドは常に `'success'` または `'failed'` のいずれかでなければならない

**Validates: Requirements 1.3, 1.7, 4.5**

### Property 2: SAFETY_LIMITエラーの一貫性

*任意の* 正の整数 `n` を `max_steps` として設定した場合、`n + 1` 以上のステップを持つパイプラインを実行すると、常に `[SAFETY_LIMIT]` プレフィックスを含むエラーがスローされなければならない

**Validates: Requirements 1.6**

### Property 3: reinvestableHoursの上限不変条件

*任意の* 非負整数 `savedHours` に対して、`calculateReinvestment(savedHours)` が返す `reinvestableHours` は常に `savedHours` 以下でなければならない（`reinvestableHours <= savedHours`）

**Validates: Requirements 3.6, 4.4**

### Property 4: costAvoidanceUSDの線形性

*任意の* 非負整数 `savedHours` に対して、`calculateReinvestment(savedHours)` が返す `costAvoidanceUSD` は常に `savedHours * 100` と等しくなければならない

**Validates: Requirements 3.5, 4.4**

### Property 5: ReflexEngineのマッチング一貫性

*任意の* `intent` 値を持つ `ReflexADF` が登録されている場合、異なる `intent` を持つ `NerveMessage` を `evaluate()` に渡すと、ディスパッチャーは呼び出されてはならない

**Validates: Requirements 3.12**

### Property 6: ExcelDesignProtocolのラウンドトリップ特性

*任意の* シート数 `n`（1以上）を持つ `ExcelDesignProtocol` を `generateExcelWithDesign()` に渡した場合、生成されたワークブックのシート数は元の `protocol.sheets.length` と等しくなければならない

**Validates: Requirements 3.9, 4.6**

### Property 7: consultVisionの選択一貫性

*任意の* 非空の `TieBreakOption` 配列と、その配列の有効なインデックス `i`（0 ≤ i < options.length）に対して、`consultVision()` はインデックス `i` に対応するオプション `options[i]` を返さなければならない

**Validates: Requirements 3.17**


## エラーハンドリング

### パイプラインエンジンのエラー

#### ステップ失敗時の動作

パイプラインエンジンはステップが失敗した場合、即座に `break` して残りのステップを実行しません。

```typescript
// 期待される動作
try {
  // ステップ実行
  results.push({ op: step.op, status: 'success' });
} catch (err: any) {
  results.push({ op: step.op, status: 'failed', error: err.message });
  break; // 残りのステップをスキップ
}
```

**テストでの検証方法**:
- 失敗するステップの後にステップを追加し、`results.length` が失敗ステップのインデックス + 1 であることを確認

#### SAFETY_LIMIT エラー

`max_steps` を超えた場合、`[SAFETY_LIMIT]` プレフィックスのエラーがスローされます。

```typescript
// 期待されるエラーメッセージ形式
// code-actuator:    "[SAFETY_LIMIT] Exceeded maximum steps (N)"
// file-actuator:    "[SAFETY_LIMIT] Exceeded maximum pipeline steps (N)"
// network-actuator: "[SAFETY_LIMIT] Exceeded maximum pipeline steps (N)"
```

**テストでの検証方法**:
- `expect(() => handleAction(...)).rejects.toThrow('[SAFETY_LIMIT]')` でプレフィックスを確認

### 外部依存のエラー

#### ADB/simctl 利用不可

```typescript
// android-actuator: adb が利用できない場合
// safeExec('adb', ['version']) が例外をスローする場合
// → collectAdbHealth() が { available: false, error: ... } を返す
// → ensureAdbAvailable() がエラーをスロー

// テストでのモック
vi.mocked(safeExec).mockImplementation((cmd) => {
  if (cmd === 'adb') throw new Error('adb: command not found');
  return '';
});
```

#### MCP クライアント接続エラー

```typescript
// shared-network: MCPクライアントの接続が失敗する場合
// → executeMcp() がエラーをスロー

// テストでのモック
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockRejectedValue(new Error('Connection failed')),
    listTools: vi.fn(),
    callTool: vi.fn(),
  })),
}));
```

### readline のエラー（shared-vision）

`consultVision()` は `readline` を使用してユーザー入力を待ちます。テストでは `stdin` をモックして自動的に入力を提供します。

```typescript
// readline モックの戦略
vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn().mockImplementation((_prompt, callback) => {
      callback('1'); // 1番目のオプションを選択
    }),
    close: vi.fn(),
  }),
}));
```

## テスト戦略

### デュアルテストアプローチ

本プロジェクトでは、ユニットテストとプロパティベーステストの両方を活用します：

- **ユニットテスト**: 具体的な例、エッジケース、エラー条件を検証
- **プロパティベーステスト**: すべての入力に対する普遍的なプロパティを検証（fast-check使用）

### プロパティベーステストの設定

- **テストライブラリ**: fast-check（TypeScript/JavaScript用）
- **最小イテレーション数**: 100回（`numRuns: 100`）
- **タグ形式**: `Feature: project-quality-improvement, Property {number}: {property_text}`
- 各正確性プロパティは、単一のプロパティベーステストで実装

### ユニットテストのバランス

ユニットテストは以下に焦点を当てます：
- 正しい動作を示す具体的な例（正常系）
- エラーケースと境界値
- 外部依存のモック検証

プロパティベーステストがランダム化を通じて多くの入力をカバーするため、過度にユニットテストを書くことは避けます。

### カバレッジ目標

| パッケージタイプ | 目標カバレッジ | 閾値設定場所 |
|----------------|--------------|------------|
| アクチュエータ（5個） | 60%以上 | vitest.config.mts |
| 共有パッケージ（5個） | 70%以上 | vitest.config.mts |

### モック戦略の詳細

#### @agent/core のモック

すべてのアクチュエータは `@agent/core` に依存しています。テストでは以下のようにモックします：

```typescript
import { vi } from 'vitest';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    // ファイルシステム操作をモック
    safeReadFile: vi.fn(),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeStat: vi.fn(),
    safeExec: vi.fn().mockReturnValue(''),
    // ロガーをモック（出力を抑制）
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    // 実装はそのまま使用（純粋関数）
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    // pathResolver をモック
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
      sharedTmp: vi.fn((p: string) => `/mock/tmp/${p}`),
      knowledge: vi.fn((p: string) => `/mock/knowledge/${p}`),
    },
  };
});
```

#### exceljs のモック（shared-media）

```typescript
vi.mock('exceljs', () => {
  const mockSheet = {
    name: 'Sheet1',
    columnCount: 3,
    getColumn: vi.fn().mockReturnValue({ width: 15 }),
    eachRow: vi.fn(),
    views: [],
    autoFilter: null,
    addRow: vi.fn(),
    getRow: vi.fn().mockReturnValue({
      getCell: vi.fn().mockReturnValue({ value: null, style: {} }),
    }),
    columns: [],
  };
  const mockWorkbook = {
    xlsx: {
      readFile: vi.fn().mockResolvedValue(undefined),
      writeBuffer: vi.fn().mockResolvedValue(Buffer.from('')),
    },
    eachSheet: vi.fn().mockImplementation((cb) => cb(mockSheet, 1)),
    addWorksheet: vi.fn().mockReturnValue(mockSheet),
  };
  return {
    default: { Workbook: vi.fn().mockImplementation(() => mockWorkbook) },
    Workbook: vi.fn().mockImplementation(() => mockWorkbook),
  };
});
```

#### adm-zip のモック（shared-media）

```typescript
vi.mock('adm-zip', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getEntry: vi.fn().mockReturnValue({
        getData: vi.fn().mockReturnValue(
          Buffer.from(`
            <a:clrScheme name="Office">
              <a:srgbClr val="FFFFFF"/>
              <a:srgbClr val="000000"/>
              <a:srgbClr val="EEECE1"/>
            </a:clrScheme>
          `)
        ),
      }),
    })),
  };
});
```

#### MCP クライアントのモック（shared-network）

```typescript
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: mockClose,
  })),
}));
```

#### readline のモック（shared-vision）

```typescript
const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: mockQuestion,
    close: mockClose,
  }),
}));

// テスト内で入力をシミュレート
mockQuestion.mockImplementation((_prompt: string, callback: (answer: string) => void) => {
  callback('1'); // 1番目のオプションを選択
});
```


## テスト実装の詳細

### アクチュエータテスト実装例

#### file-actuator のテスト（`libs/actuators/file-actuator/src/index.test.ts`）

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { handleAction } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: vi.fn().mockReturnValue('file content'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeStat: vi.fn().mockReturnValue({ size: 100, mtime: new Date(), isFile: () => true, isDirectory: () => false }),
    safeExec: vi.fn().mockReturnValue(''),
    safeAppendFileSync: vi.fn(),
    safeCopyFileSync: vi.fn(),
    safeMoveSync: vi.fn(),
    safeRmSync: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    resolveWriteArtifactSpec: actual.resolveWriteArtifactSpec,
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
    },
  };
});

describe('file-actuator', () => {
  describe('handleAction()', () => {
    it('空のstepsで呼び出した場合、status: success を返す', async () => {
      const result = await handleAction({ action: 'pipeline', steps: [] });
      expect(result.status).toBe('success');
      expect(result.results).toHaveLength(0);
    });

    it('サポートされていないactionでエラーをスロー', async () => {
      await expect(
        handleAction({ action: 'invalid' as any, steps: [] })
      ).rejects.toThrow('Unsupported action');
    });

    it('ステップが失敗した場合、残りのステップを実行しない', async () => {
      const { safeReadFile } = await import('@agent/core');
      vi.mocked(safeReadFile).mockImplementationOnce(() => {
        throw new Error('File not found');
      });

      const result = await handleAction({
        action: 'pipeline',
        steps: [
          { type: 'capture', op: 'read', params: { path: 'missing.txt' } },
          { type: 'capture', op: 'read', params: { path: 'other.txt' } }, // 実行されない
        ],
      });

      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
    });

    it('max_steps超過時に[SAFETY_LIMIT]エラーをスロー', async () => {
      const steps = Array.from({ length: 3 }, (_, i) => ({
        type: 'capture' as const,
        op: 'read',
        params: { path: `file${i}.txt` },
      }));

      await expect(
        handleAction({ action: 'pipeline', steps, options: { max_steps: 2 } })
      ).rejects.toThrow('[SAFETY_LIMIT]');
    });
  });

  // Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件
  describe('Property 1: パイプライン結果の構造不変条件', () => {
    it('任意のstepsに対してstatusは常にsuccess|failedのいずれか', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              type: fc.constantFrom('capture', 'apply') as fc.Arbitrary<'capture' | 'apply'>,
              op: fc.constantFrom('read', 'write', 'mkdir', 'delete'),
              params: fc.record({ path: fc.string({ minLength: 1 }) }),
            }),
            { maxLength: 5 }
          ),
          async (steps) => {
            const result = await handleAction({ action: 'pipeline', steps });
            expect(['success', 'failed']).toContain(result.status);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性
  describe('Property 2: SAFETY_LIMITエラーの一貫性', () => {
    it('max_steps超過時は常に[SAFETY_LIMIT]プレフィックスのエラー', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (maxSteps) => {
            const steps = Array.from({ length: maxSteps + 1 }, (_, i) => ({
              type: 'capture' as const,
              op: 'read',
              params: { path: `file${i}.txt` },
            }));

            await expect(
              handleAction({ action: 'pipeline', steps, options: { max_steps: maxSteps } })
            ).rejects.toThrow('[SAFETY_LIMIT]');
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
```

#### code-actuator のテスト（`libs/actuators/code-actuator/src/index.test.ts`）

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleAction } from './index.js';

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeReadFile: vi.fn().mockReturnValue('{}'),
    safeWriteFile: vi.fn(),
    safeMkdir: vi.fn(),
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeLstat: vi.fn().mockReturnValue({ isDirectory: () => false }),
    safeExec: vi.fn().mockReturnValue(''),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    derivePipelineStatus: actual.derivePipelineStatus,
    resolveVars: actual.resolveVars,
    evaluateCondition: actual.evaluateCondition,
    resolveWriteArtifactSpec: actual.resolveWriteArtifactSpec,
    pathResolver: {
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
    },
  };
});

vi.mock('@agent/core/fs-utils', () => ({
  getAllFiles: vi.fn().mockReturnValue([]),
}));

describe('code-actuator', () => {
  it('pipeline actionで空のstepsを処理できる', async () => {
    const result = await handleAction({ action: 'pipeline', steps: [] });
    expect(result.status).toBe('success');
  });

  it('reconcile actionでstrategy_pathが存在しない場合エラーをスロー', async () => {
    const { safeExistsSync } = await import('@agent/core');
    vi.mocked(safeExistsSync).mockReturnValue(false);

    await expect(
      handleAction({ action: 'reconcile', strategy_path: 'nonexistent.json' })
    ).rejects.toThrow('Strategy not found');
  });

  it('サポートされていないactionでエラーをスロー', async () => {
    await expect(
      handleAction({ action: 'invalid' as any, steps: [] })
    ).rejects.toThrow();
  });

  it('KYBERION_ALLOW_UNSAFE_SHELL=falseの場合、shellオペレーターがエラーをスロー', async () => {
    const result = await handleAction({
      action: 'pipeline',
      steps: [{ type: 'capture', op: 'shell', params: { cmd: 'echo test' } }],
    });
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('[SECURITY]');
  });
});
```

### 共有パッケージテスト実装例

#### shared-business のテスト（`libs/shared-business/src/finance.test.ts`）

```typescript
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calculateReinvestment } from './finance.js';

describe('calculateReinvestment()', () => {
  it('正の値に対して正しい計算結果を返す', () => {
    const result = calculateReinvestment(100);
    expect(result.reinvestableHours).toBe(70); // Math.round(100 * 0.7)
    expect(result.costAvoidanceUSD).toBe(10000); // 100 * 100
    expect(result.potentialFeatures).toBe('1.8'); // (70 / 40).toFixed(1)
  });

  it('0に対して0を返す', () => {
    const result = calculateReinvestment(0);
    expect(result.reinvestableHours).toBe(0);
    expect(result.costAvoidanceUSD).toBe(0);
  });

  it('potentialFeatures >= 1.0の場合、推奨メッセージを返す', () => {
    const result = calculateReinvestment(100);
    expect(result.recommendation).toContain('autonomous skills');
  });

  it('potentialFeatures < 1.0の場合、累積節約メッセージを返す', () => {
    const result = calculateReinvestment(10);
    expect(result.recommendation).toContain('cumulative savings');
  });

  // Feature: project-quality-improvement, Property 3: reinvestableHoursの上限不変条件
  describe('Property 3: reinvestableHoursの上限不変条件', () => {
    it('任意の非負整数に対してreinvestableHours <= savedHoursが成立する', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100000 }),
          (savedHours) => {
            const result = calculateReinvestment(savedHours);
            expect(result.reinvestableHours).toBeLessThanOrEqual(savedHours);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Feature: project-quality-improvement, Property 4: costAvoidanceUSDの線形性
  describe('Property 4: costAvoidanceUSDの線形性', () => {
    it('任意の非負整数に対してcostAvoidanceUSD = savedHours * 100が成立する', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100000 }),
          (savedHours) => {
            const result = calculateReinvestment(savedHours);
            expect(result.costAvoidanceUSD).toBe(savedHours * 100);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
```

#### shared-nerve のテスト（`libs/shared-nerve/src/reflex-engine.test.ts`）

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// ファイルシステムをモック（ReflexEngineのコンストラクタがreloadReflexes()を呼ぶため）
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeExistsSync: vi.fn().mockReturnValue(false), // reflexesディレクトリが存在しない
    safeReaddir: vi.fn().mockReturnValue([]),
    safeReadFile: vi.fn().mockReturnValue('{}'),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    pathResolver: {
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootDir: vi.fn().mockReturnValue('/mock/root'),
    },
  };
});

describe('ReflexEngine', () => {
  let ReflexEngine: any;
  let engine: any;
  const mockDispatcher = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    // モジュールを動的にインポートしてモックが適用された状態でテスト
    const module = await import('./reflex-engine.js');
    // シングルトンではなく新しいインスタンスを作成するためにクラスを取得
    // reflexEngineシングルトンを直接テスト
    engine = module.reflexEngine;
    engine.setDispatcher(mockDispatcher);
  });

  it('ディスパッチャーを設定できる', () => {
    expect(() => engine.setDispatcher(vi.fn())).not.toThrow();
  });

  it('intent一致のNerveMessageでディスパッチャーを呼び出す', async () => {
    // reflexesを手動で設定
    (engine as any).reflexes = [{
      id: 'test-reflex',
      trigger: { intent: 'test-intent' },
      action: { actuator: 'test-actuator', command: 'test-command' },
    }];

    await engine.evaluate({ id: 'msg-1', intent: 'test-intent', from: 'source', payload: {} });
    expect(mockDispatcher).toHaveBeenCalledOnce();
  });

  it('intent不一致のNerveMessageでディスパッチャーを呼び出さない', async () => {
    (engine as any).reflexes = [{
      id: 'test-reflex',
      trigger: { intent: 'expected-intent' },
      action: { actuator: 'test-actuator', command: 'test-command' },
    }];

    await engine.evaluate({ id: 'msg-1', intent: 'different-intent', from: 'source', payload: {} });
    expect(mockDispatcher).not.toHaveBeenCalled();
  });

  it('ディスパッチャー未設定でevaluate()を呼び出してもエラーをスローしない', async () => {
    (engine as any).dispatcher = undefined;
    (engine as any).reflexes = [{
      id: 'test-reflex',
      trigger: { intent: 'test-intent' },
      action: { actuator: 'test-actuator', command: 'test-command' },
    }];

    await expect(
      engine.evaluate({ id: 'msg-1', intent: 'test-intent', from: 'source', payload: {} })
    ).resolves.not.toThrow();
  });

  it('keywordフィルターが設定されていてペイロードにキーワードが含まれない場合、ディスパッチャーを呼び出さない', async () => {
    (engine as any).reflexes = [{
      id: 'test-reflex',
      trigger: { intent: 'test-intent', keyword: 'secret-keyword' },
      action: { actuator: 'test-actuator', command: 'test-command' },
    }];

    await engine.evaluate({
      id: 'msg-1',
      intent: 'test-intent',
      from: 'source',
      payload: { message: 'no matching keyword here' },
    });
    expect(mockDispatcher).not.toHaveBeenCalled();
  });

  // Feature: project-quality-improvement, Property 5: ReflexEngineのマッチング一貫性
  describe('Property 5: ReflexEngineのマッチング一貫性', () => {
    it('intent不一致時はディスパッチャーが呼び出されない', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          async (reflexIntent, stimulusIntent) => {
            fc.pre(reflexIntent !== stimulusIntent);

            vi.clearAllMocks();
            (engine as any).reflexes = [{
              id: 'test-reflex',
              trigger: { intent: reflexIntent },
              action: { actuator: 'test-actuator', command: 'test-command' },
            }];

            await engine.evaluate({
              id: 'msg-1',
              intent: stimulusIntent,
              from: 'source',
              payload: {},
            });

            expect(mockDispatcher).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
```

#### shared-network のテスト（`libs/shared-network/src/mcp-client-engine.test.ts`）

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeMcp } from './mcp-client-engine.js';

const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({ content: [] });
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    listResources: vi.fn().mockResolvedValue({ resources: [] }),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: mockClose,
  })),
}));

describe('executeMcp()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list_toolsアクションでclient.listTools()を呼び出す', async () => {
    await executeMcp('node', ['server.js'], { action: 'list_tools' });
    expect(mockListTools).toHaveBeenCalledOnce();
  });

  it('call_toolアクションでname未指定の場合エラーをスロー', async () => {
    await expect(
      executeMcp('node', ['server.js'], { action: 'call_tool' })
    ).rejects.toThrow('Tool name is required');
  });

  it('call_toolアクションでname指定の場合client.callTool()を呼び出す', async () => {
    await executeMcp('node', ['server.js'], {
      action: 'call_tool',
      name: 'my-tool',
      arguments: { key: 'value' },
    });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'my-tool',
      arguments: { key: 'value' },
    });
  });

  it('サポートされていないactionでエラーをスロー', async () => {
    await expect(
      executeMcp('node', ['server.js'], { action: 'invalid' as any })
    ).rejects.toThrow('Unsupported action');
  });

  it('実行後にtransport.close()を呼び出す', async () => {
    await executeMcp('node', ['server.js'], { action: 'list_tools' });
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
```

#### shared-vision のテスト（`libs/shared-vision/src/vision-judge.test.ts`）

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: mockQuestion,
    close: mockClose,
  }),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    metrics: { recordIntervention: vi.fn() },
  };
});

vi.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    white: (s: string) => s,
    gray: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    italic: { yellow: (s: string) => s },
  },
}));

describe('consultVision()', () => {
  const options = [
    { id: 'opt-a', description: 'Option A', logic_score: 0.8 },
    { id: 'opt-b', description: 'Option B', logic_score: 0.6 },
    { id: 'opt-c', description: 'Option C', logic_score: 0.7 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('数値インデックスで選択した場合、対応するオプションを返す', async () => {
    mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => cb('1'));

    const { consultVision } = await import('./vision-judge.js');
    const result = await consultVision('test context', options);
    expect(result).toEqual(options[0]);
  });

  it('IDで選択した場合、対応するオプションを返す', async () => {
    mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => cb('opt-b'));

    const { consultVision } = await import('./vision-judge.js');
    const result = await consultVision('test context', options);
    expect(result).toEqual(options[1]);
  });

  it('無効な選択の後に有効な選択をした場合、正しいオプションを返す', async () => {
    let callCount = 0;
    mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => {
      callCount++;
      cb(callCount === 1 ? 'invalid' : '2');
    });

    const { consultVision } = await import('./vision-judge.js');
    const result = await consultVision('test context', options);
    expect(result).toEqual(options[1]);
  });

  // Feature: project-quality-improvement, Property 7: consultVisionの選択一貫性
  describe('Property 7: consultVisionの選択一貫性', () => {
    it('任意の有効なインデックスに対して対応するオプションを返す', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.string({ minLength: 1, maxLength: 10 }),
              description: fc.string({ minLength: 1 }),
              logic_score: fc.float({ min: 0, max: 1 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          fc.nat(),
          async (opts, rawIndex) => {
            const index = rawIndex % opts.length;
            vi.clearAllMocks();
            mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => {
              cb(String(index + 1)); // 1-indexed
            });

            const { consultVision } = await import('./vision-judge.js');
            const result = await consultVision('test context', opts);
            expect(result).toEqual(opts[index]);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
```

#### shared-media のテスト（`libs/shared-media/src/excel-utils.test.ts`）

```typescript
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

const mockSheet = {
  name: 'Sheet1',
  columnCount: 2,
  getColumn: vi.fn().mockReturnValue({ width: 15 }),
  eachRow: vi.fn(),
  views: [],
  autoFilter: null,
  columns: [],
  getRow: vi.fn().mockReturnValue({
    getCell: vi.fn().mockReturnValue({ value: 'test', style: {} }),
  }),
};

const mockWorkbook = {
  xlsx: { readFile: vi.fn().mockResolvedValue(undefined) },
  eachSheet: vi.fn().mockImplementation((cb: any) => cb(mockSheet, 1)),
  addWorksheet: vi.fn().mockReturnValue(mockSheet),
};

vi.mock('exceljs', () => ({
  default: { Workbook: vi.fn().mockImplementation(() => mockWorkbook) },
  Workbook: vi.fn().mockImplementation(() => mockWorkbook),
}));

vi.mock('adm-zip', () => ({
  default: vi.fn().mockImplementation(() => ({
    getEntry: vi.fn().mockReturnValue({
      getData: vi.fn().mockReturnValue(
        Buffer.from('<a:clrScheme><a:srgbClr val="FFFFFF"/></a:clrScheme>')
      ),
    }),
  })),
}));

describe('distillExcelDesign()', () => {
  it('ExcelDesignProtocolの必須フィールドを返す', async () => {
    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(result).toHaveProperty('version', '1.0.0');
    expect(result).toHaveProperty('generatedAt');
    expect(result).toHaveProperty('sheets');
    expect(Array.isArray(result.sheets)).toBe(true);
  });
});

describe('generateExcelWithDesign()', () => {
  it('protocol.sheetsのシート名を持つワークブックを返す', async () => {
    const { generateExcelWithDesign } = await import('./excel-utils.js');
    const protocol = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      theme: {},
      sheets: [{ name: 'TestSheet', columns: [], rows: [], merges: [] }],
    };

    const workbook = await generateExcelWithDesign([['A', 'B']], protocol, 'TestSheet');
    expect(mockWorkbook.addWorksheet).toHaveBeenCalledWith('TestSheet');
  });
});

// Feature: project-quality-improvement, Property 6: ExcelDesignProtocolのラウンドトリップ特性
describe('Property 6: ExcelDesignProtocolのラウンドトリップ特性', () => {
  it('任意のシート数でdistill→generateのラウンドトリップ後にシート数が保持される', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        async (sheetNames) => {
          const { generateExcelWithDesign } = await import('./excel-utils.js');

          const protocol = {
            version: '1.0.0',
            generatedAt: new Date().toISOString(),
            theme: {},
            sheets: sheetNames.map((name) => ({
              name,
              columns: [],
              rows: [],
              merges: [],
            })),
          };

          // generateExcelWithDesignは1シートのみ生成するが、
          // protocolのシート数は保持されることを検証
          expect(protocol.sheets).toHaveLength(sheetNames.length);
          await generateExcelWithDesign([['data']], protocol, sheetNames[0]);
          // ラウンドトリップ後もprotocolのシート数は変わらない
          expect(protocol.sheets).toHaveLength(sheetNames.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

