# IP-10: 巨大ファイルの分割

> 優先度: P2 / 規模: L(ファイル単位のフェーズ分割前提) / 依存: **IP-07(特性化テストが先)**

## 背景と課題

4,500〜5,300 行級のファイルが 5 つあり、いずれも変更影響範囲が読めない状態。

| ファイル                                                                     | 行数         | 特記事項                                                   |
| ---------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------- |
| `presence/displays/chronos-mirror-v2/src/components/MissionIntelligence.tsx` | 5,329        | 単一 React コンポーネント                                  |
| `scripts/check_contract_schemas.ts`                                          | 4,969        | `validate` ゲート。テストゼロ(IP-07 Task 3 が前提)         |
| `satellites/voice-hub/server.ts`                                             | 4,560(163KB) | workspace 外の単一ファイルサーバ。浮遊 Promise あり(IP-08) |
| `libs/actuators/wisdom-actuator/src/decision-ops.ts`                         | 2,831        |                                                            |
| `libs/actuators/media-actuator/src/index.ts`                                 | 2,627        | any 最多クラスタ(IP-11 と相互作用)                         |
| `libs/core/surface-runtime-orchestrator.ts`                                  | 1,844        | リクエスト経路の中枢。特性化テスト(IP-07 Task 4/5)が前提   |
| `libs/core/index.ts`                                                         | 1,617        | 純バレル(554 export)— 分割対象ではなく現状維持でよい       |

## ゴール(受入条件)

- 対象ファイルが責務単位のモジュールに分割され、各ファイル 800 行以下を目安とする。
- 分割の前後で既存テスト(+ IP-07 の特性化テスト)が緑のまま。公開 API(import パス)は原則不変(バレル/再エクスポートで互換維持)。
- 1 ファイル = 1 フェーズ = 1 ブランチ/パッチ。全部を一度にやらない。

## 実施順序と担当

| フェーズ | 対象                                             | 分割設計                    | 実装              |
| -------- | ------------------------------------------------ | --------------------------- | ----------------- |
| 1        | `check_contract_schemas.ts`                      | `claude-opus`               | `claude-sonnet-4` |
| 2        | `voice-hub/server.ts`                            | `claude-opus`               | `claude-sonnet-4` |
| 3        | `surface-runtime-orchestrator.ts`                | `claude-opus`               | `claude-sonnet-4` |
| 4        | `MissionIntelligence.tsx`                        | `claude-sonnet-4`(設計込み) | `claude-sonnet-4` |
| 5        | `media-actuator/src/index.ts`・`decision-ops.ts` | `claude-sonnet-4`(設計込み) | `claude-sonnet-4` |

フェーズ 1〜3 は中枢/ゲートのため設計を opus に分離。4〜5 は UI・アクチュエータ内部で影響が局所的なため sonnet 単独でよい。

## 各フェーズ共通の手順(実装エージェントへの指示)

1. **安全網の確認**: 対象の既存テストを実行し緑を確認。テストが薄い場合はフェーズ開始前に IP-07 の該当タスクを完了させる。
2. **設計**: ファイルを読み、責務クラスタ(型定義 / 純関数群 / I/O・外部呼び出し / エントリポイント)を同定して分割案(新ファイル名と移動する宣言の一覧)を作る。設計担当が opus のフェーズでは、この分割案を本文書末尾に追記してから実装に渡す。
3. **機械的移動**: 宣言単位で新モジュールへ移動し、元ファイルは再エクスポートで互換維持。**ロジックの書き換え・改善はしない**(pure move)。リファクタ的改善は分割完了後の別コミットに分ける。
4. **検証**: `pnpm typecheck` → 対象テスト → `pnpm lint`。UI(フェーズ4)は `pnpm build:ui` と chronos-mirror-v2 の既存テスト 6 本。
5. **循環 import の検出**: 分割で `libs/core` 内の循環が発生しやすい。`pnpm check:esm` を各フェーズで実行する。

## フェーズ個別の注意

- **フェーズ1(check_contract_schemas)**: 走査・ルール評価・レポート出力の 3 層に割るのが自然。ルール定義をデータ(テーブル)化できれば行数が大きく落ちるが、それは「改善コミット」として分離する。
- **フェーズ2(voice-hub)**: 分割と同時に IP-06 の方針に沿って workspace パッケージ化(`package.json` + `src/` 構成)する。ルーティング / セッション管理 / タスク実行 / STT・音声 I/O の 4 クラスタが見込み。IP-08 Task 6 の `.catch` 付与を先に済ませておくこと。
- **フェーズ3(surface-runtime-orchestrator)**: IP-07 Task 5 の特性化テストが全部緑であることを開始条件とする。import 40+ の配線部と、判断ロジック(fastpath 判定、delegation 選択)を分離する。
- **フェーズ4(MissionIntelligence.tsx)**: サブコンポーネント・hooks・型を `MissionIntelligence/` ディレクトリに抽出する標準的な React 分割。視覚回帰が確認できないため、props とレンダリング分岐を変えない pure move を厳守する。

## リスクと注意

- pure move と改善を混ぜると diff レビューが不可能になる。**「移動コミット」と「改善コミット」を必ず分ける**こと。
- 元ファイルを再エクスポートに残すことで、deep import(`@agent/core/surface-runtime-orchestrator` 等 230 箇所ある deep import 慣行)を壊さない。
