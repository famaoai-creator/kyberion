# Voice Interface Protocol (VIP) - Integrated Flow Edition

Gemini CLI における「統合型」ハンズフリー操作の標準プロトコル。

## 1. 動作モデル：統合ターミナル・フロー

従来の外部ループスクリプト（chat_loop）を廃止し、標準のターミナル対話の中でエージェントが自律的にマイクを制御する。

- **入力**: ユーザーが音声入力（Dictation）でプロンプトを入力し、Enter で送信。
- **処理中**: Enter 送信により OS 側で音声入力が自動 OFF になる。
- **回答出力**: エージェントが回答を表示。
- **フィードバック**: 回答終了時に `speak.cjs` で音声を生成。
- **次ターンの準備**: 読み上げ完了後、エージェントが `osascript` でマイクを再度 ON にする。

## 2. 実装の役割分担

- **エージェントの責務**:
  - 全てのターンの最後に `speak.cjs` と `osascript (keycode: 176)` を実行する。
  - 長い回答やコードブロックを適切にクリーンアップして発話させる。
- **スキルの責務**:
  - `voice-interface-maestro` は、OS 状態に依存しないクリーンな発話エンジンを提供すること。

## 3. 設定の優先順位

1. `knowledge/personal/voice/config.json` の `dictationKeycode` を絶対的なトリガーとする。
2. 音声ペルソナは言語自動判定に基づいて選択する。
