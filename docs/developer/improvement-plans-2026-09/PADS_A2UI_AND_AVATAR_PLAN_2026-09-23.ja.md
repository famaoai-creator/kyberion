---
title: ローカルパッドの A2UI 化と話すアバター計画
tags: [design-system, a2ui, local-pads, voice, avatar, improvement-plan, 2026-09]
last_updated: 2026-09-23
status: active
mission: MSN-PADS-A2UI-20260923
---

# ローカルパッドの A2UI 化と話すアバター計画(PA-01〜PA-10)

[サーフェス UI 統一計画](./SURFACE_UI_UNIFICATION_PLAN_2026-09-23.ja.md)(PR #778)の続き。対象は `scripts/*` 配下のローカルパッド 9 種 + `personal-pads` 統合シェル。

## 1. 背景(ヒアリング結果 2026-09-23)

- パッドも surface と同様に A2UI `kyberion-base` ベースにしたい。
- レビュー用ツールバー、描画用パレットメニューもコンポーネント化したい。
- 音声をインタラクティブに扱う UI には視覚フィードバック(入力レベル、状態)が欲しい。
- アバターが話すときの口パク、1 枚の写真からアバターを作る仕組みが欲しい。

決定事項:

| 項目               | 決定                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| 写真アバターの範囲 | 写真を参照画像として画像生成に渡し、スタイライズ + 表情セット(4〜5 種)を作る |
| 口パクの表示先     | 相棒(presence-studio)と秘書室(concierge)                                     |
| PR 分割            | PR 1: パッド + 新コンポーネント + i18n / PR 2: 口パク + 写真アバター         |
| 国際化             | 必須(en / ja 最低限)。直書き日本語は語彙カタログへ移す                       |

## 2. 現状(調査結果)

- パッドは `node:http` + TS テンプレート内のインライン HTML/CSS/JS。`@agent/shared-ui` / `kyberion-ui.css` / `--kb-ui-*` は未使用。
- ツールバーは絵文字ボタン列、描画パレットは 3 か所(sketch-input、screenshot-annotate、personal-pads)に重複実装。
- 確認・入力は `confirm()` / `prompt()`。音声は録音中にラベルが「⏹」になるだけで、レベル表示はない。
- i18n: report-review / sketch-input / meeting-notepad は語彙カタログ済み。5 パッドはインライン ja/en 表、personal-pads と personal-workbench は日本語直書き。
- 口パク: オフライン MP4 レンダラ(`render_talking_avatar`、音量駆動)のみ。`realtime-media-session.ts` の viseme / `mouth_open` 契約は未使用。ライブ画面は表情ごとの静止画切替。
- 写真アバター: 撮影・アップロード・登録は動くが、`generate_avatar.ts` は写真を画像生成に渡していない(汎用プロンプトのみ)。

## 3. 新コンポーネント(`kyberion-base` に追加)

| type                 | 役割                                                                                    | 状態の持ち方                           |
| -------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `ui:toolbar`         | ボタン / トグル / ファイル / 区切り / 状態表示。WAI-ARIA toolbar(矢印キー移動)          | 制御(pressed はホストが渡す)           |
| `ui:dialog`          | `confirm()` / `prompt()` の置き換え。確認・入力・複数選択肢(保存 / 破棄 / キャンセル)   | 制御(open)                             |
| `ui:drawing-palette` | 描画ツール・色スウォッチ・太さ・元に戻す・消去                                          | 制御                                   |
| `ui:sketch-board`    | パレット + キャンバス(背景画像、テキストはインライン入力、元に戻す 40 手、PNG 取り出し) | 内部状態(コントローラを action で渡す) |
| `ui:voice-input`     | マイク(トグル / 押して話す)、入力レベルメーター、経過時間、途中認識テキスト、録音モード | 内部状態                               |
| `ui:voice-state`     | 待機 / 聞いている / 考え中 / 話している / ミュート / エラー の状態表示(レベル連動可)    | 制御                                   |

原則は UI-01 と同じ: props は JSON Schema で検証、ファイル・音声・画像は `onAction` のペイロードでのみ受け渡し、既定文言は `ui` 語彙(en/ja)、React / vanilla の両レンダラで同じマークアップ(パリティテスト)。

## 4. 実装項目

| ID    | 内容                                                                                                                     | PR  |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | --- |
| PA-01 | `ui:toolbar` / `ui:dialog` / `ui:drawing-palette` / `ui:sketch-board`(schema・型・React・vanilla・CSS・語彙・ギャラリー) | 1   |
| PA-02 | `ui:voice-input` / `ui:voice-state`(入力レベル、押して話す、録音モード)                                                  | 1   |
| PA-03 | パッド共通基盤: `/shared-ui/*`・`kyberion-ui.css`・トークン・語彙バンドル配信、ロケール/テーマ解決                       | 1   |
| PA-04 | sketch-input / screenshot-annotate / personal-pads の描画を `ui:sketch-board` に統一                                     | 1   |
| PA-05 | report-review のツールバー・コメント・ダイアログを共通化(stamp 版もオフラインで動く)                                     | 1   |
| PA-06 | meeting-notepad / memory-capture / doc-drop / clipboard-inbox / daily-desk / personal-workbench を移行                   | 1   |
| PA-07 | personal-pads / 5 パッドの直書き文言を語彙カタログへ(en/ja)、i18n ベースライン削減                                       | 1   |
| PA-08 | スクリーンショット撮影対象にパッドを追加、README / SURFACES / DESIGN_SYSTEM 更新                                         | 1   |
| PA-09 | `ui:talking-avatar`: 再生音声の音量で口を動かす(viseme 契約に載せ替え可能)、相棒・秘書室に表示                           | 2   |
| PA-10 | 写真 → アバター: 参照画像付き画像生成(対応プロバイダ)で表情セット生成、`generate_avatar` を修正                          | 2   |

## 5. 検証

- `pnpm check -- --scope pr`、ui-ux / i18n / catalogs / design-contrast。
- 新コンポーネントの React / vanilla パリティ(en / ja)、各パッドのサーバーテスト。
- パッドの before / after スクリーンショット(ja / en × light / dark)。
