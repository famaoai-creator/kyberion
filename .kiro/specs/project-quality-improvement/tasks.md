# 実装計画: プロジェクト品質向上（テストカバレッジ拡充）

## 概要

本実装計画は、Kyberionプロジェクトのテストカバレッジを段階的に拡充するための具体的なタスクを定義します。
**既存のプロダクションコードは一切変更しません。** テストファイルの追加のみを行います。

5つのフェーズに分けて、fast-checkの導入、テストなしアクチュエータへのテスト追加、共有パッケージへのテスト追加、既存アクチュエータのテスト品質向上、カバレッジ確認を実施します。

## タスク

### フェーズ1: 準備

- [x] 1. fast-checkのインストール
  - ルートの `package.json` の `devDependencies` に `fast-check` を追加する
  - `pnpm install` を実行してインストールを確認する
  - _要件: 4.1_

### フェーズ2: テストなしアクチュエータへのテスト追加

- [x] 2. android-actuatorのテスト作成
  - [x] 2.1 `libs/actuators/android-actuator/src/index.test.ts` を新規作成する
    - `@agent/core` の `safeExec`・`safeExistsSync`・`safeMkdir`・`safeReadFile`・`safeWriteFile`・`logger`・`pathResolver` をモックする
    - 正常系: `adb_health_check` でadb利用可能な場合に `adb_available: true` を返すことを検証する
    - エラーケース: `adb_health_check` でadb利用不可な場合に `adb_available: false` を返すことを検証する
    - エラーケース: `launch_app` でadb未利用可能時にエラーをスローすることを検証する
    - エラーケース: `tap` で座標を指定して `safeExec` が正しい引数で呼ばれることを検証する
    - エラーケース: `capture_screen` でスクリーンショット取得後に `last_screenshot_path` が設定されることを検証する
    - _要件: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.2 android-actuatorのProperty 1プロパティテストを作成する
    - **Property 1: パイプライン結果の構造不変条件**
    - **検証: 要件 1.3, 1.7, 4.5**
    - `fc.array` で任意のステップ配列を生成し、`handleAction()` の返り値の `status` が常に `'success'` または `'failed'` であることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件`

  - [x] 2.3 android-actuatorのProperty 2プロパティテストを作成する
    - **Property 2: SAFETY_LIMITエラーの一貫性**
    - **検証: 要件 1.6**
    - `fc.integer({ min: 1, max: 10 })` で任意の `max_steps` を生成し、`max_steps + 1` 以上のステップを持つパイプラインが常に `[SAFETY_LIMIT]` プレフィックスのエラーをスローすることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性`

- [x] 3. code-actuatorのテスト作成
  - [x] 3.1 `libs/actuators/code-actuator/src/index.test.ts` を新規作成する
    - `@agent/core` および `@agent/core/fs-utils` をモックする
    - 正常系: `pipeline` actionで空のstepsを処理できることを検証する
    - エラーケース: `reconcile` actionで `strategy_path` が存在しない場合にエラーをスローすることを検証する
    - エラーケース: サポートされていない `action` でエラーをスローすることを検証する
    - エラーケース: `KYBERION_ALLOW_UNSAFE_SHELL=false` の場合、`shell` オペレーターが `[SECURITY]` プレフィックスのエラーを返すことを検証する
    - _要件: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 3.2 code-actuatorのProperty 1プロパティテストを作成する
    - **Property 1: パイプライン結果の構造不変条件**
    - **検証: 要件 1.3, 1.7, 4.5**
    - `fc.array` で任意のステップ配列を生成し、`handleAction()` の返り値の `status` が常に `'success'` または `'failed'` であることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件`

  - [x] 3.3 code-actuatorのProperty 2プロパティテストを作成する
    - **Property 2: SAFETY_LIMITエラーの一貫性**
    - **検証: 要件 1.6**
    - `fc.integer({ min: 1, max: 10 })` で任意の `max_steps` を生成し、`max_steps + 1` 以上のステップを持つパイプラインが常に `[SAFETY_LIMIT]` プレフィックスのエラーをスローすることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性`

- [x] 4. file-actuatorのテスト作成
  - [x] 4.1 `libs/actuators/file-actuator/src/index.test.ts` を新規作成する
    - `@agent/core` をモックする（`safeReadFile`・`safeWriteFile`・`safeMkdir`・`safeExistsSync`・`safeReaddir`・`safeStat`・`safeExec`・`safeAppendFileSync`・`safeCopyFileSync`・`safeMoveSync`・`safeRmSync`・`logger`・`pathResolver`）
    - 正常系: 空のstepsで `status: 'success'` を返すことを検証する
    - エラーケース: サポートされていない `action` でエラーをスローすることを検証する
    - エラーケース: ステップが失敗した場合に残りのステップを実行せず `status: 'failed'` を返すことを検証する
    - エラーケース: `max_steps` 超過時に `[SAFETY_LIMIT]` エラーをスローすることを検証する
    - _要件: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 4.2 file-actuatorのProperty 1プロパティテストを作成する
    - **Property 1: パイプライン結果の構造不変条件**
    - **検証: 要件 1.3, 1.7, 4.5**
    - `fc.array` で任意のステップ配列を生成し、`handleAction()` の返り値の `status` が常に `'success'` または `'failed'` であることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件`

  - [x] 4.3 file-actuatorのProperty 2プロパティテストを作成する
    - **Property 2: SAFETY_LIMITエラーの一貫性**
    - **検証: 要件 1.6**
    - `fc.integer({ min: 1, max: 10 })` で任意の `max_steps` を生成し、`max_steps + 1` 以上のステップを持つパイプラインが常に `[SAFETY_LIMIT]` プレフィックスのエラーをスローすることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性`

- [x] 5. ios-actuatorのテスト作成
  - [x] 5.1 `libs/actuators/ios-actuator/src/index.test.ts` を新規作成する
    - `@agent/core` の `safeExec`・`safeExistsSync`・`safeMkdir`・`safeReadFile`・`safeWriteFile`・`logger`・`pathResolver` をモックする
    - 正常系: `simctl_health_check` でsimctl利用可能な場合に `ios_available: true` を返すことを検証する
    - エラーケース: `simctl_health_check` でsimctl利用不可な場合に `ios_available: false` を返すことを検証する
    - エラーケース: `launch_app` で `bundle_id` 未指定時にエラーをスローすることを検証する
    - 正常系: `boot_simulator` で既にBooted状態の場合にエラーなしで完了することを検証する
    - 正常系: `capture_screen` でスクリーンショット取得後に `last_screenshot_path` が設定されることを検証する
    - _要件: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ]\* 5.2 ios-actuatorのProperty 1プロパティテストを作成する
    - **Property 1: パイプライン結果の構造不変条件**
    - **検証: 要件 1.3, 1.7, 4.5**
    - `fc.array` で任意のステップ配列を生成し、`handleAction()` の返り値の `status` が常に `'success'` または `'failed'` であることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件`

  - [ ]\* 5.3 ios-actuatorのProperty 2プロパティテストを作成する
    - **Property 2: SAFETY_LIMITエラーの一貫性**
    - **検証: 要件 1.6**
    - `fc.integer({ min: 1, max: 10 })` で任意の `max_steps` を生成し、`max_steps + 1` 以上のステップを持つパイプラインが常に `[SAFETY_LIMIT]` プレフィックスのエラーをスローすることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性`

- [x] 6. network-actuatorのテスト作成
  - [x] 6.1 `libs/actuators/network-actuator/src/index.test.ts` を新規作成する
    - `@agent/core` をモックする（`safeReadFile`・`safeWriteFile`・`safeMkdir`・`safeExistsSync`・`safeExec`・`logger`・`pathResolver`）
    - 正常系: 空のstepsで `status: 'success'` を返すことを検証する
    - エラーケース: サポートされていない `action` でエラーをスローすることを検証する
    - エラーケース: ステップが失敗した場合に残りのステップを実行せず `status: 'failed'` を返すことを検証する
    - エラーケース: `max_steps` 超過時に `[SAFETY_LIMIT]` エラーをスローすることを検証する
    - _要件: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]\* 6.2 network-actuatorのProperty 1プロパティテストを作成する
    - **Property 1: パイプライン結果の構造不変条件**
    - **検証: 要件 1.3, 1.7, 4.5**
    - `fc.array` で任意のステップ配列を生成し、`handleAction()` の返り値の `status` が常に `'success'` または `'failed'` であることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 1: パイプライン結果の構造不変条件`

  - [ ]\* 6.3 network-actuatorのProperty 2プロパティテストを作成する
    - **Property 2: SAFETY_LIMITエラーの一貫性**
    - **検証: 要件 1.6**
    - `fc.integer({ min: 1, max: 10 })` で任意の `max_steps` を生成し、`max_steps + 1` 以上のステップを持つパイプラインが常に `[SAFETY_LIMIT]` プレフィックスのエラーをスローすることを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 2: SAFETY_LIMITエラーの一貫性`

- [x] 7. チェックポイント - テストなしアクチュエータの確認
  - すべてのテストが正常に実行されることを確認し、質問があればユーザーに確認してください。

### フェーズ3: 共有パッケージへのテスト追加

- [x] 8. shared-businessのテスト作成
  - [x] 8.1 `libs/shared-business/src/finance.test.ts` を新規作成する
    - 正常系: `calculateReinvestment(100)` が `reinvestableHours: 70`・`costAvoidanceUSD: 10000`・`potentialFeatures: '1.8'` を返すことを検証する
    - 正常系: `calculateReinvestment(0)` が `reinvestableHours: 0`・`costAvoidanceUSD: 0` を返すことを検証する
    - 正常系: `potentialFeatures >= 1.0` の場合に推奨メッセージが `'autonomous skills'` を含むことを検証する
    - 正常系: `potentialFeatures < 1.0` の場合に推奨メッセージが `'cumulative savings'` を含むことを検証する
    - _要件: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]\* 8.2 shared-businessのProperty 3プロパティテストを作成する
    - **Property 3: reinvestableHoursの上限不変条件**
    - **検証: 要件 3.6, 4.4**
    - `fc.integer({ min: 0, max: 100000 })` で任意の非負整数を生成し、`calculateReinvestment(n).reinvestableHours <= n` が常に成立することを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 3: reinvestableHoursの上限不変条件`

  - [ ]\* 8.3 shared-businessのProperty 4プロパティテストを作成する
    - **Property 4: costAvoidanceUSDの線形性**
    - **検証: 要件 3.5, 4.4**
    - `fc.integer({ min: 0, max: 100000 })` で任意の非負整数を生成し、`calculateReinvestment(n).costAvoidanceUSD === n * 100` が常に成立することを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 4: costAvoidanceUSDの線形性`

- [x] 9. shared-mediaのテスト作成
  - [x] 9.1 `libs/shared-media/src/excel-utils.test.ts` を新規作成する
    - `exceljs` および `adm-zip` をモックする（design.mdのモック実装例を参照）
    - 正常系: `distillExcelDesign()` が `version`・`generatedAt`・`sheets` フィールドを含む `ExcelDesignProtocol` を返すことを検証する
    - 正常系: `generateExcelWithDesign()` が `protocol.sheets` のシート名で `addWorksheet` を呼び出すことを検証する
    - _要件: 3.1, 3.2, 3.3, 3.7, 3.8, 3.10_

  - [ ]\* 9.2 shared-mediaのProperty 6プロパティテストを作成する
    - **Property 6: ExcelDesignProtocolのラウンドトリップ特性**
    - **検証: 要件 3.9, 4.6**
    - `fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 })` で任意のシート名配列を生成し、`generateExcelWithDesign` 呼び出し後も `protocol.sheets.length` が変化しないことを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 6: ExcelDesignProtocolのラウンドトリップ特性`

- [x] 10. shared-nerveのテスト作成
  - [x] 10.1 `libs/shared-nerve/src/reflex-engine.test.ts` を新規作成する
    - `@agent/core` をモックする（`safeExistsSync: false`・`safeReaddir: []`・`safeReadFile`・`logger`・`pathResolver`）
    - 正常系: `intent` が一致する `NerveMessage` でディスパッチャーが呼び出されることを検証する
    - 正常系: `intent` が一致しない `NerveMessage` でディスパッチャーが呼び出されないことを検証する
    - 正常系: `keyword` フィルターが設定されていてペイロードにキーワードが含まれない場合にディスパッチャーが呼び出されないことを検証する
    - 正常系: ディスパッチャー未設定で `evaluate()` を呼び出してもエラーをスローしないことを検証する
    - _要件: 3.1, 3.2, 3.3, 3.11, 3.12, 3.13, 3.14_

  - [x] 10.2 shared-nerveのProperty 5プロパティテストを作成する
    - **Property 5: ReflexEngineのマッチング一貫性**
    - **検証: 要件 3.12**
    - `fc.string({ minLength: 1, maxLength: 20 })` で2つの異なる `intent` 文字列を生成し（`fc.pre` で不一致を保証）、intent不一致時にディスパッチャーが呼び出されないことを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 5: ReflexEngineのマッチング一貫性`

- [x] 11. shared-networkのテスト作成
  - [x] 11.1 `libs/shared-network/src/mcp-client-engine.test.ts` を新規作成する
    - `@modelcontextprotocol/sdk/client/index.js` および `@modelcontextprotocol/sdk/client/stdio.js` をモックする（design.mdのモック実装例を参照）
    - 正常系: `action: 'list_tools'` で `client.listTools()` が呼び出されることを検証する
    - エラーケース: `action: 'call_tool'` で `name` 未指定の場合に `"Tool name is required"` を含むエラーをスローすることを検証する
    - 正常系: `action: 'call_tool'` で `name` 指定の場合に `client.callTool()` が正しい引数で呼び出されることを検証する
    - エラーケース: サポートされていない `action` でエラーをスローすることを検証する
    - 正常系: 実行後に `transport.close()` が呼び出されることを検証する
    - _要件: 3.1, 3.2, 3.3, 3.15, 3.16_

- [x] 12. shared-visionのテスト作成
  - [x] 12.1 `libs/shared-vision/src/vision-judge.test.ts` を新規作成する
    - `node:readline`・`@agent/core`・`chalk` をモックする（design.mdのモック実装例を参照）
    - 正常系: 数値インデックスで選択した場合に対応するオプションを返すことを検証する
    - 正常系: IDで選択した場合に対応するオプションを返すことを検証する
    - 正常系: 無効な選択の後に有効な選択をした場合に正しいオプションを返すことを検証する
    - _要件: 3.1, 3.2, 3.3, 3.17, 3.18_

  - [x] 12.2 shared-visionのProperty 7プロパティテストを作成する
    - **Property 7: consultVisionの選択一貫性**
    - **検証: 要件 3.17**
    - `fc.array(fc.record({ id: fc.string(), description: fc.string(), logic_score: fc.float({ min: 0, max: 1 }) }), { minLength: 1, maxLength: 5 })` と `fc.nat()` で任意のオプション配列と有効なインデックスを生成し、`consultVision()` が対応するオプションを返すことを検証する（`numRuns: 100`）
    - タグ: `Feature: project-quality-improvement, Property 7: consultVisionの選択一貫性`

- [x] 13. チェックポイント - 共有パッケージの確認
  - すべてのテストが正常に実行されることを確認し、質問があればユーザーに確認してください。

### フェーズ4: 既存アクチュエータのテスト品質向上

- [ ] 14. カバレッジ60%未達アクチュエータのテスト補強
  - [x] 14.1 `pnpm test:coverage` を実行して各アクチュエータの現在のカバレッジを確認する
    - カバレッジレポート（`./coverage/`）を参照して60%未達のアクチュエータを特定する
    - _要件: 2.1_

  - [ ] 14.2 カバレッジ60%未達アクチュエータの既存テストファイルにエラーケースを追加する
    - 対象: agent-actuator, approval-actuator, artifact-actuator, blockchain-actuator, browser-actuator, daemon-actuator, media-actuator, media-generation-actuator, meeting-actuator, meeting-browser-driver, modeling-actuator, orchestrator-actuator, physical-bridge, presence-actuator, process-actuator, secret-actuator, service-actuator, system-actuator, terminal-actuator, video-composition-actuator, vision-actuator, voice-actuator, wisdom-actuator のうちカバレッジ60%未達のもの
    - 各アクチュエータの正常系に加えてエラーケース・境界値（空の入力・最大値・不正な型）を追加する
    - 外部依存（ファイルシステム・ネットワーク・外部プロセス）は `vi.mock()` でモックする
    - _要件: 2.1, 2.2, 2.3, 2.4_

- [~] 15. チェックポイント - 既存アクチュエータの確認
  - すべてのテストが正常に実行されることを確認し、質問があればユーザーに確認してください。

### フェーズ5: カバレッジ確認

- [ ] 16. カバレッジ目標の達成確認
  - [~] 16.1 `pnpm test:coverage` を実行してカバレッジレポートを生成する
    - アクチュエータ全体でlines・functions・branches・statementsが60%以上であることを確認する
    - 共有パッケージ全体でlines・functions・branches・statementsが70%以上であることを確認する
    - _要件: 5.1, 5.2, 5.3_

  - [~] 16.2 カバレッジが目標未達のパッケージがある場合、追加テストを作成して目標を達成する
    - `./coverage/coverage-summary.json` を参照して未達パッケージを特定する
    - 未達パッケージの既存テストファイルにテストケースを追加する
    - _要件: 5.1, 5.2, 5.3_

- [~] 17. 最終チェックポイント - カバレッジ目標達成の確認
  - `pnpm test:coverage` が非ゼロの終了コードなしで完了し、すべてのカバレッジ目標が達成されていることを確認し、質問があればユーザーに確認してください。

## 注意事項

- `*` マークが付いたサブタスクはオプションであり、より迅速なMVPのためにスキップ可能です
- 各タスクは具体的な要件番号を参照しており、トレーサビリティを確保しています
- チェックポイントタスクで段階的な検証を行い、問題を早期に発見します
- プロパティテストは普遍的な正確性プロパティを検証し、ユニットテストは具体的な例とエッジケースを検証します
- **既存のプロダクションコードは一切変更しません**
