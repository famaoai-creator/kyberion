---
title: 行為プレイブック（会話する / 手を動かす / 移動する — 対象ごとにどの実行器を使うか）
category: Orchestration
tags:
  [
    orchestration,
    action,
    computer-use,
    browser-actuator,
    system-actuator,
    terminal-actuator,
    presence,
    voice,
    tts,
    navigation,
  ]
importance: 8
author: Ecosystem Architect
last_updated: 2026-09-25
role_affinity: [ecosystem_architect, mission_controller, implementer, operator]
phase_affinity: [alignment, execution]
---

# 行為プレイブック

[知覚プレイブック](./perception-playbook.ja.md) の対になる文書。エージェントが**行為する**（何かを伝える、画面やターミナルを操作する、どこかへ移る）とき、どのレイヤーを使うかをまとめる。正本は英語版 [action-playbook.md](./action-playbook.md)。まだ一語動詞になっていない能力（作る側、画像・動画生成、記憶の軸）は [capability-verb-inventory.ja.md](./capability-verb-inventory.ja.md) で管理する。

知覚と違い、行為には「1行為1コマンド」はない。行為は**対象ごとに意図的に分かれている**（Web ページ・デスクトップアプリ・ターミナルでは実行器も承認ゲートも異なる）。対象を決め、それを実行できる最も狭い段を選ぶ。

## 1. 最も狭い段を選ぶ（ネイティブ op の段階）

1. 決定的な op か既存パイプライン（`pipelines/`）
2. 既存のアクチュエータ op か統制された CLI（`pnpm kyberion …`）
3. ブラウザ / セッション操作
4. デスクトップ GUI 操作 — API や CLI で表せないときだけ

出典: [native-op-ladder.md](./native-op-ladder.md)。段を上げるには理由が要る。

## 2. 手を動かす — 対象ごとの実行器

3つとも同じ `computer_interaction` 契約（`knowledge/product/schemas/computer-interaction.schema.json` の `target.executor`）で話す。**重複ではなく**、操作の集合も重ならない。

| 対象                    | 実行器                                                              | 代表的な操作                                                                                                         |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Web ページ              | `browser-actuator`（Playwright）、`pnpm kyberion browser run`       | `goto`、snapshot → `click_ref` / `fill_ref` / `fill_secret_ref`、スクロール、`extract_text_ref`、`screenshot`        |
| デスクトップアプリ / OS | `system-actuator` の `computer_interaction`（os-automation-bridge） | `activate_application`、クリック / 移動、フォーカス中の入力欄への入力 / 送信、タイトル/URL でのタブ操作、`open_path` |
| ターミナル / シェル     | `terminal-actuator`（PTY）                                          | セッションの起動 / 書き込み / 読み取り / 終了、`shell_command`                                                       |
| ファイル / コード       | `file` / `code` のパイプライン op、または Write / Edit              | `write_file`、`regex_replace`                                                                                        |
| モバイル端末            | `android-actuator` / `ios-actuator`                                 | `launch_app`、`open_deep_link`、タップ、`capture_screen`                                                             |
| 渡すための文書          | `pnpm kyberion write <brief.json> --out <file>`                     | セマンティックブリーフから pptx / docx / xlsx / pdf（`media:generate_document`）。`read` の逆                        |

- **画面キャプチャ**は `system:screenshot` / `system:record_screen`（画面の伏せ字処理を通る）。`media-generation` / `vision` のキャプチャ op はそこへ転送するだけ。ページのキャプチャは `browser:screenshot`。
- 詳細: [browser-automation-best-practices.md](./browser-automation-best-practices.md)、[computer-use-runtime-model.md](../architecture/computer-use-runtime-model.md)、[os-automation-bridge-model.md](../architecture/os-automation-bridge-model.md)。

## 3. 移動する — 手の一部

独立した移動レイヤーはない。「移動」は手の実行器の中でのフォーカス変更である: `browser:goto`（ページ）、`system` の `activate_application` / `open_path` / `activate_tab_by_url`（アプリ・ファイル・タブ）、`ios` / `android` の `launch_app` / `open_deep_link`（アプリ画面）。物理的な移動（ロボット・GPS）は存在しない。

## 4. 会話する

| 目的                             | 使うもの                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| どのテキスト窓口でも人に応答する | 会話の窓口 `runSurfaceMessageConversation`（`libs/core/surface-runtime-orchestrator.ts`）。`ask`、Slack / Telegram / Discord / iMessage のサテライト、voice-hub、concierge、Chronos が既に使っている |
| ターミナルから Kyberion に聞く   | `pnpm kyberion ask "<text>"`                                                                                                                                                                         |
| メッセージを送る                 | チャネル接頭辞付きの `presence:dispatch`（`slack:`、`telegram:` …）                                                                                                                                  |
| 声に出す / 音声ファイルを作る    | `pnpm kyberion speak "<text>" [--out <file>]`（`listen` の逆）。パイプラインでは `voice:generate_voice` / `voice:speak_local`                                                                        |
| リアルタイム音声対話             | `pnpm kyberion voice conversation-turn` — [voice-interface-protocol.md](./voice-interface-protocol.md) 参照                                                                                          |
| エージェント同士                 | Co-Session / Peer Messaging — [agent-communication-layer-model.md](../architecture/agent-communication-layer-model.md)                                                                               |

新しい窓口を推論バックエンドに直結して追加しない。テナントスコープ・監査・承認が効くよう、会話の窓口の裏に登録する。

## 5. 罠

1. **GUI を自作で自動化しない。** `osascript`、`cliclick`、`xdotool`、`screencapture`、素の `say`、pyautogui / pynput、その場しのぎの Playwright スクリプトはシェルポリシー（`gui-hand-automation`）が拒否し、この文書へ案内する。`libs/core` の統制されたブリッジは、伏せ字処理と承認付きで内部的にこれらを使う。
2. **秘密情報は `fill_secret_ref` で入力する。** 平文で打ち込まない。
3. **危険な操作は承認を待つ**（削除・送信・購入）。承認待ちを実行器の切り替えで回避しない。
4. **音声会話は現状、会話の窓口を通らない唯一の経路**（`realtime-voice-conversation.ts` が推論バックエンドを直接呼ぶ）。音声セッションが何に届き得るかを監査するときは念頭に置く。
