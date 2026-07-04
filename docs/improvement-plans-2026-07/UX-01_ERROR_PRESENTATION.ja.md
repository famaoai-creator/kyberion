# UX-01: エラー提示の統一 — 生エラーの露出と「無言の失敗」をなくす

> 優先度: **P0** / 規模: M / 依存: なし / 関連: IP-08(内部エラーハンドリング)、[USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md)

## 背景と課題

ユーザーがエラーに遭遇したときの体験が2つの極端に割れている: **生の内部エラーがそのまま見える**(chronos)か、**何も返ってこない**(全テキストブリッジ)か。

### A. 生エラー・内部例外がそのままユーザーに表示される(chronos-mirror-v2)

- `presence/displays/chronos-mirror-v2/src/app/api/agent/route.ts:1232-1236` — 最上位 catch が `{ error: err.message }` をそのまま返す。
- `src/components/SovereignChat.tsx:107` — `data.error` をエージェントの発話としてそのまま描画。`:124` は `connection error: ${err.message}`(`Failed to fetch` 等)をチャットバブルに表示。
- `src/components/MissionIntelligence.tsx:1785-1798` — エラーパネルの `detail={error}` に、バックエンドの `body.error` や生 JS エラーがそのまま入る(設定箇所は `:1139,1266,1292,1315,1337,1360,1508,1534,1557,1586,1677,1755`)。

### B. 無言の失敗がテキストブリッジの既定挙動(4ブリッジ全部)

- **slack-bridge**: メッセージハンドラの catch はログのみ(`satellites/slack-bridge/src/index.ts:393-395`)— エージェントが throw するとユーザーには**何も返らない**。`empty_reply` 時も無投稿(`:383-392`)。承認決定失敗(`:418-420`)、onboarding モーダル失敗(`:442,456,480`)も同様。
- **telegram-bridge**: `conversation.text` 空なら無送信(`:325`)。webhook エラーは Telegram サーバに JSON を返すだけ(`:429-434`)。
- **discord-bridge**: catch はログのみ(`:161-163`)、空返答は無反応(`:148`)。さらに **2,000 文字超の返信は `message.reply` が throw → catch に飲まれ、長い回答ほど無言になる**(`:150`、チャンク分割なし)。
- **imessage-bridge**: ポーリング catch はログのみ(`:91-93`)、空返答無反応(`:83`)。

### C. 音声(voice-hub)はエラーが「聞こえない」

- 返答生成エラーは JSON ボディに載るだけで**発話されない**(`satellites/voice-hub/server.ts:1360-1364,1375-1377`)。TTS 失敗も `logger.warn` のみ(`:1196-1198,1356`)。音声のみのユーザーには沈黙。

## ゴール(受入条件)

1. すべてのユーザー接点で、失敗時に「①わかりやすい一文 + ②次にできること」が**必ず**返る(USER_EXPERIENCE_CONTRACT の language boundary 準拠。生 `err.message`・スタックは出さない。詳細は trace/log 側に残す)。
2. 空返答(`empty_reply`)時も「結果が生成できなかった」旨の定型応答が返る。
3. Discord の 2,000 文字制限でメッセージが消えない(チャンク分割)。
4. 音声経路では、失敗時に短い定型音声(「うまく処理できませんでした。もう一度お願いします」相当)が再生される。

## 実装タスク

### Task 1: ユーザー向けエラー封筒の共通実装 — `claude-sonnet-4`

1. `libs/core/surface-response-blocks.ts` 周辺(surface 系の共通整形の既存の家)を確認し、`buildUserFacingError(err, opts: { locale, surface, traceId? }): { title, body, nextAction }` を実装する。
   - 内部エラーを既知カテゴリ(接続失敗 / タイムアウト / 承認待ち / 権限 / 不明)に分類し、`knowledge/product/orchestration/user-facing-vocabulary.json` に追加するエラー語彙(en/ja ペア)から文言を引く。
   - `traceId` があれば「詳細は trace <id>」の一行を付ける。生 `err.message` は**含めない**(logger には全量渡す)。
2. 語彙カタログへのエントリ追加は既存のスキーマ・`check:catalogs` に従う。
3. unit test: カテゴリ分類・locale 切替・message 非漏洩(`err.message` の文字列が出力に含まれない)の3点。

### Task 2: chronos-mirror-v2 への適用 — `claude-sonnet-4`

1. `api/agent/route.ts:1232-1236` を Task 1 の封筒に置換(HTTP 500 は維持、body を構造化)。
2. `SovereignChat.tsx:107,124` は封筒の `title/body/nextAction` を描画する形へ。`MissionIntelligence.tsx` のエラーパネルは `detail` に生文字列でなく封筒を受けるよう、`:1139` 以下の 12 箇所の設定側を共通ヘルパー(`toPanelError(err)`)経由に統一する。
3. エラーパネルのタイトル "Unable to load mission intelligence"(ハードコード英語)を `uxText` 経由にする(本格的なローカライズ一掃は UX-03)。
4. `pnpm build:ui` と chronos の既存テスト 6 本で確認。

### Task 3: 4 ブリッジの無言失敗解消(パターン確立 → 横展開)— slack は `claude-sonnet-4`、他 3 つは `claude-haiku`(slack の diff を添付)

1. slack-bridge で確立するパターン: (a) 会話ハンドラ catch でユーザーのチャネルへ Task 1 封筒の text 版を投稿、(b) `empty_reply` 時に定型文を投稿、(c) 投稿自体の失敗は従来どおりログ。
2. telegram / discord / imessage に同パターンを展開。discord は追加で 1,900 文字での安全なチャンク分割ヘルパーを入れる(コードブロック境界を壊さない単純分割でよい)。
3. 各ブリッジのテスト(あるもの)+ 手動のスモーク手順(README 記載のローカル起動)で確認。

### Task 4: voice-hub の音声エラーフィードバック — `claude-sonnet-4`

1. `server.ts` の返答生成エラー経路(`:1360-1364,1375-1377`)で、`buildVoiceFallbackReply`(`:4310` 既存)相当の短い定型応答を**発話まで**行う(タイムアウト経路では既に返す仕組みがあるので、同経路に合流させる)。
2. TTS 主経路(MLX)失敗時は既存の `say` フォールバック(`:1196-1198`)が動くことをテストで固定する。
3. 発話ループ(エラー通知自体の TTS が失敗して再帰しない)ガードを入れる。

## リスクと注意

- ブリッジがエラー文を投稿するようになると、リトライ嵐の際にユーザーへ連投される可能性がある。**同一会話への連続エラー投稿は 1 分に 1 回**の簡易レート制限を Task 3 のパターンに含めること。
- 封筒の文言は LLM 生成にしない(決定論・語彙カタログ準拠)。会話文脈に応じた言い換えが欲しい場合も、まず定型で出してから将来の改善とする。

## 実装メモ

- 2026-07-04: `libs/core/error-classifier.ts` に `buildUserFacingError()` を追加し、`knowledge/product/orchestration/user-facing-vocabulary.json` へエラー語彙を追加した。Chronos の `FocusedOperatorView` / `MissionIntelligence` / `SovereignChat` は、内部例外を直接描画せず、ブラウザ安全な封筒表現に差し替えた。
