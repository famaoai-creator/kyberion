# IP-05: アクチュエータ CLI エントリポイントの共通化と入力検証

> 優先度: P1 / 規模: M / 依存: なし / 関連: IP-08(エラーハンドリング)、IP-06(workspace 整合)

## 背景と課題

- 30 アクチュエータのうち **27 の `src/index.ts` が同一の `main()` ボイラープレート**(`createStandardYargs()` → `safeReadFile(inputPath)` → `JSON.parse` → `handleAction` → `console.log` → `.catch(exit 1)`)をコピペで持つ。バイト単位で同一構造の例: `libs/actuators/process-actuator/src/index.ts:6-27` と `libs/actuators/presence-actuator/src/index.ts:6-27`。入力処理やエラー書式の変更は現状 27 箇所の修正を要する。
- **17 ファイルが `handleAction(JSON.parse(inputContent))` を無検証で実行**しており、不正 JSON は生の `SyntaxError` になり、`any` ペイロードが業務ロジックへ素通りする(例: `media-generation-actuator/src/media-generation-action-helpers.ts:449`、`vision-actuator/src/index.ts:125`)。スキーマ検証があるのは calendar / modeling / video-composition / voice の 4 つのみ。satellite ブリッジ(外部入力)がこの経路に流れ込むため、堅牢性・セキュリティ両面のギャップ。

## ゴール(受入条件)

1. `@agent/core` に共通ランナー `runActuatorCli()` が実装され、unit test を持つ。
2. 27 アクチュエータ全てが共通ランナーへ移行し、各アクチュエータの既存テストが緑のまま。
3. 不正 JSON 入力時に構造化エラー(actuator 名・原因・exit code 1)が返る。
4. スキーマを持つアクチュエータは共通ランナーの `schema` オプション経由で検証される(最低限、既存 4 つの検証挙動を退行させない)。

## 実装タスク

### Task 1: 共通ランナーの設計・実装 — `claude-sonnet-4`

1. 27 個の `index.ts` の `main()` を読み比べ、差異(出力形式、追加フラグ、VITEST ガードの有無)を一覧化する。
2. `libs/core/cli-utils.ts`(`createStandardYargs` の既存の家)に以下のシグネチャで実装する:
   ```ts
   export async function runActuatorCli(opts: {
     name: string; // アクチュエータ名(エラー表示用)
     handleAction: (input: unknown) => Promise<unknown>;
     schema?: object; // 任意: Ajv で入力検証(pipeline-contract.ts の既存 Ajv 利用に合わせる)
     printResult?: (result: unknown) => void; // 既定: JSON.stringify を console.log
   }): Promise<void>;
   ```

   - `safeReadFile` による入力読込、`JSON.parse` の try/catch(失敗時は `[<name>] invalid JSON input: <message>` を stderr に出し exit 1)、schema 指定時の Ajv 検証、`handleAction` 例外時の構造化エラー出力と exit 1、直接実行ガード(`!process.env.VITEST`)を内包する。
3. `libs/core/cli-utils.test.ts` にテストを追加: 正常系 / 不正 JSON / スキーマ違反 / handleAction 例外 の 4 ケース。
4. `libs/core/index.ts`(バレル)からエクスポートする。

### Task 2: パイロット移行(3件)— `claude-sonnet-4`

1. 構造が最も標準的な `process-actuator`、`presence-actuator`、テストが厚い `service-actuator` の 3 つを移行し、各パッケージのテストを実行して緑を確認する。
2. 移行 diff の典型例を本文書末尾に「移行パターン」として追記する。

### Task 3: 残り 24 アクチュエータの横展開 — `claude-haiku`(Task 2 の移行パターンを添付。5件ずつのバッチで実施)

- 1 バッチごとに `vitest run libs/actuators/<対象5つ>` を実行して緑を確認する。以下は注意対象なのでパターンと差異があれば sonnet へエスカレーション:
  - `media-actuator`(2,627行、独自フラグあり)
  - `wisdom-actuator` / `orchestrator-actuator`(複数エントリポイント)
  - スキーマ検証済みの calendar / modeling / video-composition / voice(検証ロジックを `schema` オプションへ移設し、挙動維持をテストで確認)
  - `daemon-actuator` は移行**しない**(IP-06 で retire 予定)

### Task 4: 入力スキーマの段階的整備 — `claude-sonnet-4`

1. `schemas/` 直下に既存のアクチュエータ入力スキーマがあるか棚卸しし、対応表を作る。
2. 外部入力に晒されやすい順(browser / meeting / email / file / system)に、`manifest.json` の action 定義から最低限の入力スキーマ(必須フィールドと型のみ)を起こし、`schema` オプションに接続する。1 アクチュエータごとに不正入力テストを 1 ケース追加する。
3. 全アクチュエータのスキーマ完備は本 IP のスコープ外(上位 5 つまで)。残りは対応表に「未整備」と記録して終了する。

## リスクと注意

- エラーメッセージの文言変更は、出力を文字列マッチしている呼び出し元(orchestrator-actuator や pipelines の `system:shell` ステップ)を壊す可能性がある。Task 1 で `grep -rn "invalid\|Error:" pipelines/ libs/actuators/orchestrator-actuator` により出力パースの依存を確認し、既存文言を維持する側に倒す。
- package.json が無い 4 アクチュエータ(IP-06 対象)も `tsconfig.actuators.json` のワイルドカードでコンパイルされるため移行対象に含めるが、テスト実行は vitest のパス指定で行う。
