# UX-02: 長時間処理の進捗可視化

> 優先度: P1 / 規模: M / 依存: なし / 関連: [OPERATOR_UX_GUIDE](../../OPERATOR_UX_GUIDE.md)(`Intent → Plan → State → Result` の約束)

## 背景と課題

OPERATOR_UX_GUIDE は「何が起きているかを見せる」ことを核の約束にしているが、実際には**長時間処理の間ユーザーはほぼ何も見えない**。

- **ターミナル(最重要)**: `scripts/run_pipeline.ts` はコンソールに開始(`:752-754` `🚀 Running ADF pipeline`)と終了(`:786,817-820`)しか出さない。ステップ単位の `step.started/completed/duration_ms` は **trace オブジェクトにのみ**書かれ(`:343,354-361`)、画面には出ない。`reasoning:analyze` が数分ブロックしても無音。ステップカウンタ(`[3/12]`)も経過時間も無い。
- **自律修復が沈黙のまま走る**: ステップ失敗時 `Attempting autonomous repair...`(`:572`)の後、LLM サブエージェント(`:632-673`)が数分走り得るが、「ハング」と「自己修復中」の区別がつかない。
- **ミッションの生きた状態が見えない**: `mission_controller.ts status <ID>`(`:994-1055`)は点のスナップショットのみ。実行中ミッションを tail する手段が無い。
- **テキストブリッジにタイピング表示が無い**: `satellites/` 全体に `sendTyping / sendChatAction / typing` のヒットゼロ。長い応答の間、Slack/Telegram/Discord/iMessage のユーザーは無反応に見える。
- **chronos チャットはスピナーのみ**: `SovereignChat.tsx:82-132` は非ストリーミング POST 一発で、進捗テキストもキャンセルボタンも無い(SSE ルート `/api/intelligence/stream` は既存)。
- **進捗通知がオプトイン**: `libs/core/surface-interaction-model.ts:250-287` は呼び出し側が `startedText` 等を渡した時だけ通知し、既定タイトルは英語ハードコード(`Working`/`Completed`/`Failed`、`:254,265,276`)。
- **voice-hub の同期ターン**: 20 秒タイムアウトまで無音(`server.ts:4288-4304`)。非同期委譲時の即時アック(`:4264-4287`)は良い実装なので、これを基準にする。

## ゴール(受入条件)

1. パイプライン実行中、ターミナルに「ステップ番号/総数・ステップ名・経過時間」が逐次表示される(`--quiet` で従来挙動)。自律修復開始時は「修復サブエージェント実行中(数分かかることがあります)」が明示される。
2. `mission status --follow <ID>`(または `mission tail`)で実行中ミッションのイベントを追える。
3. 4 ブリッジすべてで、処理開始時にタイピング表示(または「処理中」リアクション/一言)が出る。
4. chronos チャットに処理中のキャンセル操作と、最低限のフェーズ表示(受領→実行中→整形中)が付く。
5. `surface-interaction-model` の進捗通知が既定でオン(呼び出し側が明示的に抑止しない限り出る)になり、既定文言が語彙カタログ経由になる。

## 実装タスク

### Task 1: run_pipeline のコンソール進捗 — `claude-sonnet-4`

1. `run_pipeline.ts` の trace 書き込み箇所(`:343,354-361`)にフックし、`logger.info` で `[step 3/12] reasoning:analyze … (12s)` 形式の行を出す。ステップ完了時に duration を表示。`--quiet` フラグ(既存フラグ体系に追加)で抑止可能に。
2. 自律修復(`:572` 以降)開始・終了時に、修復対象ステップ名と「サブエージェント実行中」の行を追加。
3. `pnpm pipeline --input pipelines/baseline-check.json` で出力を目視確認。出力を文字列パースしている既存呼び出し(orchestrator の shell ステップ等)が無いか grep で確認し、既存行は変更せず**追記のみ**とする。

### Task 2: mission の follow モード — `claude-sonnet-4`

1. `mission_controller.ts` の status 実装(`:994-1055`)が読むイベント源(mission ledger / task events)を確認し、`--follow` オプションで追記を 2 秒間隔ポーリング表示する(tail -f 相当。ファイルウォッチが secure-io 経由で可能ならそちら)。
2. Ctrl-C で正常終了。表示語彙はミッション status enum を生で出さず、既存アイコンマップ(`:557-567`)を流用する。
3. テスト: fixture の ledger に追記して follow 出力が増えることを確認する unit test。

### Task 3: ブリッジのタイピング表示 — `claude-sonnet-4`(slack でパターン確立)→ `claude-haiku`(telegram/discord 横展開)

1. slack: 処理開始時に「👀 リアクション付与 or 短い『処理中…』メッセージ→完了時に更新」のうち、Bolt の API で確実に動く方式を選び実装(Socket Mode の制約を確認)。
2. telegram: `sendChatAction('typing')` を応答生成中 4 秒間隔で送出。discord: `channel.sendTyping()` 同様。
3. imessage は送信 API 制約上タイピング表示が無いため、5 秒超の処理で「処理中です」の先行一言を送る方式にする(voice-hub の async-ack パターン踏襲)。

### Task 4: chronos チャットのキャンセルとフェーズ表示 — `claude-sonnet-4`

1. `SovereignChat.tsx` の `sendQuery` を `AbortController` 対応にし、スピナーバブルに「キャンセル」ボタンを付ける(サーバ側 route が中断を安全に扱えるかを確認し、最低限クライアント側の待ち解除でもよい — その場合はサーバ処理が続く旨を表示)。
2. 既存 SSE ルートの流用可否を確認し、可能なら `受領 → 実行中 → 整形中` の 3 フェーズをスピナーバブルに表示する。ストリーミング本文表示までは本 IP のスコープ外。

### Task 5: surface-interaction-model の既定オン化 — `claude-sonnet-4`

1. `surface-interaction-model.ts:250-287` を「`progressTexts` 未指定でも既定文言で通知する」挙動に変更し、抑止用の明示オプション(`progress: false`)を追加する。既定文言(`Working`/`Completed`/`Failed`)は語彙カタログの en/ja エントリに置換(UX-03 と整合)。
2. 既存呼び出し元を grep し、通知が二重になる箇所(既に自前で通知しているもの)には `progress: false` を指定する。
3. 既存テスト + 通知既定オンの新テスト。

## リスクと注意

- 進捗行の増加はログ量を増やす。trace への記録は従来どおりとし、コンソール行は人間向けの要約に留める(1 ステップ 2 行まで)。
- ブリッジの「処理中」メッセージは完了時に編集/削除できるプラットフォームでは編集し、できない場合は残す(連投感を避けるため 1 ターン 1 回まで)。

## 実装メモ

- 2026-07-04: `libs/core/ux-vocabulary.ts` に progress 状態を追加し、`surface-interaction-model.ts` の既定進捗通知を vocabulary 経由に切り替えた。`locale` を `SurfaceSpaceContext` に持たせることで、`ja` では `処理中 / 完了 / 失敗` が出ることを `surface-interaction-model.test.ts` で固定した。
- 2026-07-11: pipeline 完了ログが `results.length + 1` により `[step 2/1]` となる回帰を修正。開始時の step number を完了ログまで固定し、logger capture test と baseline-check 実走で検証する。
- 2026-07-11: chronos `SovereignChat` に AbortController によるキャンセルと経過時間ベースのフェーズ表示(送信中→思考中→長時間経過)を追加。文言は `user-facing-vocabulary.json` の `chronos_chat_cancel` / `chronos_chat_phase_*` キー経由で ja/en を解決する。

## 実装状況 追記 (2026-07-12)

**Task 3 完了(4ブリッジのタイピング表示)— UX-02 は DONE。**

- 共通ヘルパー `libs/core/bridge-typing.ts`: `startBridgeTypingLoop`(即時発火 + 間隔更新、表示失敗は1回だけ警告し応答を妨げない)/ `scheduleBridgeProcessingNote`(5秒超のみ先行一言 — 速い応答は汚さない)。
- **discord**: `channel.sendTyping()` を8秒間隔で維持。**telegram**: `sendChatAction('typing')` を4秒間隔(dry-run/トークン欠落は no-op)。**slack**: bot に typing API が無いため、受信メッセージへ 👀 リアクション付与→応答時に除去(失敗は cosmetic 扱い)。**imessage**: typing API 無しのため voice-hub の async-ack パターン踏襲で「処理中です…」の先行一言(5秒超のみ)。
- テスト: ヘルパー3本(fake timers で発火/停止/失敗耐性/遅延一言)+ 既存ブリッジテスト緑。
