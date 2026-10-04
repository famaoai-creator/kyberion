---
title: Conversation Engine 改良計画(音声会話を STT→LLM→TTS 直列から対話制御ループへ)
tags:
  [
    voice,
    realtime,
    conversation-engine,
    interaction-controller,
    turn-taking,
    improvement-plan,
    2026-10,
  ]
last_updated: 2026-10-04
status: partial
---

# Conversation Engine 改良計画(CE)

## 1. 背景

2026-10-04 の対話で出た結論: **音声会話は `STT → LLM → TTS` の直列ではなく、LLM の外側に Conversation Engine を持つ**。エンジンが常時保持する情報は 4 種類:

| 情報                     | 内容                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Turn State**           | 誰のターンか。`LISTENING / HOLDING / BACKCHANNEL / TAKING / SPEAKING / YIELDING` 程度に絞る                                  |
| **Continuous Signals**   | 二択にしない値。`end_of_turn_probability` / `interruption_probability` / `backchannel_probability` / `user_engagement`(0〜1) |
| **Conversation Context** | 内容だけでなく発話意図。「説明中」「考えながら喋っている」「質問を組み立てている」「訂正している」                           |
| **User Rhythm**          | その人固有の間・話速・相槌頻度・割り込み許容度。会話中に適応する                                                             |

設計の柱は 3 つ:

1. **知的応答と会話反応の分離** — 「うん」「なるほど」「ちょっと待ってね」は高速な Conversation Engine が先に返し、裏で本命 LLM が推論する。`Conversation Engine → TTS` の直接ショートカット経路を持つ。
2. **文章単位で考えない** — 発話を `Reaction → Claim → Explanation → Next` に分け、`Reaction` が生成できた瞬間に発声し、その間に後続を生成する。
3. **音声専用にしない** — 人間と AI の意図・状態・主導権を管理する汎用 **Interaction Controller** として設計する。会話も組織運営も `Observe → Infer State → Decide Who Acts → Act` の同型ループであり、「AI が会社を動かす OS」の抽象化に直結する。

参考: 直前の [ELIZA_ADOPTION_PLAN_2026-09-24.ja.md](../improvement-plans-2026-09/ELIZA_ADOPTION_PLAN_2026-09-24.ja.md)(EV-01〜08、done)がターンテイキングの純粋部品を導入済み。本計画はその延長線で、**部品はほぼ揃っており、足りないのはエンジンとしての統合と応答側の反応経路**である。

## 2. 現状との照合(コードベース調査済み)

### 2.1 既にあるもの

| 概念                                 | 実装                                                                                                                                                          | 状態                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| EOT 確率(連続値)                     | `libs/core/voice/voice-eot-scorer.ts` `scoreEndOfTurn` → [0,1] + `EotHoldAggregator`                                                                          | あり(ルールベース、ja/en、`knowledge/product/voice/turn-taking-lexicon.json` で語彙を SSoT 管理) |
| ターンテイキング判定機械             | `libs/core/voice/voice-turn-taking.ts` `VoiceTurnTakingMachine`(`vad_start/vad_silence/stt_partial/stt_final/tts_start/tts_end/tick` → action)                | あり。純粋・時計注入済み。ただし **workbench 専用**(§2.3)                                        |
| 相槌 vs 割り込みの区別               | `libs/core/two-stage-barge-in.ts`(energy → 暫定 pause → STT partial の語数で hard_stop / resume)。`barge_in_backchannels` で「うんうん」は語数 0 → 停止しない | 部分的。語彙ベースのみ、暫定 pause は必ず挟む                                                    |
| 応答ゲート(フィラー・自声エコー除去) | `libs/core/voice/voice-respond-gate.ts`                                                                                                                       | あり                                                                                             |
| 推測応答(仮無音 250ms で推論先行)    | `libs/core/voice/voice-speculative-policy.ts`                                                                                                                 | あり(明示 opt-in、battery/metered で強制 off)                                                    |
| フレーズ分割ストリーミング TTS       | `libs/core/voice/voice-phrase-chunker.ts`(初句 24 字・`、` 切断可)+ `voice-first-phrase-cache.ts`                                                             | あり(文字レベルの分割のみ、意味的分割ではない)                                                   |
| ターン中止トークン                   | `libs/core/voice/voice-turn-cancellation.ts`(理由: `barge_in/eot_revoked/external/timeout/user_cancel`)                                                       | あり                                                                                             |
| 評価基盤                             | `libs/core/voice/voice-workbench.ts`(fake-clock シナリオ再生、EOT 遅延・誤 barge-in・TTFA 計測)                                                               | あり                                                                                             |
| イベントバス                         | `libs/core/realtime-media-session.ts` `MediaEventBuffer`(meeting/avatar が同一イベントを購読)                                                                 | あり                                                                                             |
| ネイティブ音声モデル経路             | `libs/core/voice/gemini-live-client.ts`                                                                                                                       | あり(別経路、§6 参照)                                                                            |
| ガバナンス                           | recording consent fail-closed、turn ごとの trace(listen/stt/llm/first-audio/speak)、`realtime-media-session-architecture.md` §13 に契約文書                   | あり                                                                                             |

### 2.2 足りないもの

| ギャップ                               | 現状                                                                                                                                          | 影響                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Turn State の一元モデル**            | 状態が `ttsActive` / `userSpeaking` / barge-in の `phase` / ループの `listening/thinking/speaking` に分散。外部から読める単一の会話状態がない | 「今誰のターンか」を surface・ログ・適応ロジックが参照できない                                            |
| **連続シグナルの不足**                 | 0〜1 の値は `end_of_turn_probability` のみ。割り込み判定は語数の二値                                                                          | `interruption_probability` / `backchannel_probability` / `user_engagement` が無く、判定が硬い             |
| **発話意図の分類なし**                 | EOT/barge-in は表層語彙のみ。「いや違う」(訂正→破棄)と「ちょっと待って」(保留→聞き続ける)が区別できず、どちらも hard_stop                     | 割り込み後の振る舞い(破棄 vs 一時停止継続)を意図に応じて変えられない                                      |
| **エージェント側の相槌生成なし**       | 全発話が reasoning backend 経由。`CE → TTS` のショートカットなし                                                                              | 聞いている間の「うん」「なるほど」が出せない。応答冒頭の反応も LLM 待ち                                   |
| **意味的応答分割なし**                 | `streamRealtimeAssistantReply` は raw delta を `VoicePhraseChunker` で文字分割                                                                | `Reaction → Claim → Explanation → Next` の構造がなく、Reaction を LLM 無しで埋める余地がない              |
| **User Rhythm 適応なし**               | 全閾値が定数(provisional 150ms / tentative 250ms / grace 600ms / hold 1500ms)                                                                 | 間の長い人・早口の人・相槌の多い人に同じ挙動で当たる                                                      |
| **汎用 Interaction Controller でない** | 判定が `libs/core/voice/` に音声イベント前提で埋め込まれている                                                                                | `Observe → Infer → Decide → Act` を会話以外(chat、会議ファシリテーション、ミッション統制)に再利用できない |

### 2.3 リファクタすべきもの

- **判定ロジックの二重実装**: `VoiceTurnTakingMachine` は `voice-workbench.ts` からしか使われていない。本番ループ `realtime-voice-loop.ts`(1308 行)は同じ部品(`TwoStageBargeIn` / `EotHoldAggregator` / respond gate / speculative policy)を**手で組み立て直しており**、機械とループで判定が乖離しうる。ループを機械の action 消費者に寄せるのが最初のリファクタ。
- **閾値の定数埋め込み**: 上記タイミング定数が機械・ループ・ポリシーに散在。`UserRhythm` が上書きできるポリシーオブジェクトに集約する。
- **応答パイプラインの単一経路**: `streamRealtimeAssistantReply` が「LLM 全文 → 分割 → TTS」の一本道。Reaction の先行注入点を設ける。

## 3. 設計方針

- **エンジンは pure、I/O はアダプタ**(EV シリーズと同じ原則)。`ConversationEngine` は `at_ms` を持つイベントを受け、`InteractionState` + `Signals` + `Action[]` を返す純粋モジュール。音声・マイク・TTS には触れない。
- **`VoiceTurnTakingMachine` をエンジンの核に昇格**し、本番ループと workbench が同一実装を回す。
- **音声非依存の型に寄せる**: 入力は `speech_onset / speech_offset / transcript_partial / transcript_final / output_started / output_ended / tick` 程度に抽象化し、将来 chat や会議イベントも同じ機械に流せる形にする(voice 用語はアダプタ層に押し出す)。
- **判定は段階的に賢くする**: Phase 1 は lexicon/ルール拡張で決定性を保ち、意図分類だけは後方で `apple-intelligence-bridge` 等の軽量分類 seam に差し替え可能なインターフェースにする。本命 LLM は反応経路に載せない。
- **後方互換**: 新挙動は opt-in フラグ(`--conversation-engine` または latency profile 拡張)で段階投入。`barge-in-mode` / `eot-hold` 等の既存契約は `realtime-media-session-architecture.md` §13 に追記して維持。
- **配置**: エンジン本体は `libs/core/interaction/`(新設)、音声アダプタは `libs/core/voice/` に残す。語彙・ポリシー・rhythm 既定値は `knowledge/product/` の SSoT に置く(turn-taking-lexicon と同じ方式)。
- **言語はデータ駆動の言語パック**: ja/en をコードに特別扱いせず、言語ごとの語彙(継続助詞・フィラー・確定語尾・相槌・訂正語・保留語)とルールテーブルを「言語パック」として lexicon SSoT に持つ構造にする。エンジンは `LanguagePack` インターフェース経由でのみ言語に触れ、新言語の追加はデータ追加で済む形にする(日本語ファーストを維持しつつ英語特化にもしない)。

## 4. ワークアイテム

| ID    | 内容                                                                                                                                                                                                                                                                       | 主なファイル                                                                                                                | 完了条件                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CE-01 | **InteractionState 一元化**: `LISTENING / HOLDING / BACKCHANNEL / TAKING / SPEAKING / YIELDING` を `VoiceTurnTakingMachine` が公開する単一状態として定義し、現行の暗黙状態(`ttsActive`/`userSpeaking`/`phase`)を写像                                                       | `libs/core/voice/voice-turn-taking.ts`、新規 `libs/core/interaction/interaction-state.ts`                                   | 既存 workbench シナリオ全件 pass + 各シナリオで期待する state 遷移列を検証できる                                          |
| CE-02 | **ループの機械駆動化**: `realtime-voice-loop.ts` が自前で束ねている判定を `VoiceTurnTakingMachine.step()` の action 消費に置き換え、二重実装を解消                                                                                                                         | `libs/core/voice/realtime-voice-loop.ts`                                                                                    | 既存の barge-in / eot-hold / respond-gate / speculative の挙動が不変(§13 契約のリグレッションテスト化)                    |
| CE-03 | **Continuous Signals**: `Signals { end_of_turn_probability, interruption_probability, backchannel_probability, user_engagement }` をエンジンが毎イベント更新・公開。v1 はルール合成(EOT スコア・語彙・無音長・発話速度)、算出器は差し替え可能 seam                         | 新規 `libs/core/interaction/interaction-signals.ts`、`voice-turn-taking.ts`                                                 | workbench で各シグナルの値列を assert できる。MediaEvent に signals を載せる                                              |
| CE-04 | **発話意図分類**: `explaining / thinking_aloud / composing_question / correcting / holding / backchannel / substantive` を返す `UtteranceIntentClassifier` seam。v1 は lexicon 拡張(訂正語「いや/違う」、保留語「ちょっと/待って」)の決定版、軽量モデル差し替えは別計画    | 新規 `libs/core/interaction/utterance-intent.ts`、`knowledge/product/voice/turn-taking-lexicon.json` 拡張                   | 「いや違う」→ hard_stop+turn 破棄、「ちょっと待って」→ pause 継続+保留、「うんうん」→ 継続発話、を workbench で区別できる |
| CE-05 | **相槌生成 + CE→TTS ショートカット**: LISTENING 中に `backchannel_probability` が閾値超過かつ最小間隔を満たすとき、engine が `emit_backchannel` action を出し、ループが `FirstPhraseCache`/streaming TTS で LLM を介さず発声。応答冒頭の Reaction も同一経路で先行発声可能 | `libs/core/voice/realtime-voice-loop.ts`、新規 `libs/core/interaction/backchannel-policy.ts`、`voice-first-phrase-cache.ts` | 相槌が transcript に発話者区別つきで記録される。LLM 呼び出し回数が増えないこと。off が既定                                |
| CE-06 | **構造化応答 `Reaction → Claim → Explanation → Next`**: 応答生成を semantic segment 契約に拡張。`Reaction` slot は CE が即時供給可能(LLM 無し)、`Claim` 以降は LLM ストリームが上書き継続。`VoicePhraseChunker` は segment 単位で駆動                                      | `libs/core/voice/realtime-voice-conversation.ts`(`streamRealtimeAssistantReply`)、prompt builder                            | TTFA が現行計測より悪化しない(workbench + 実測 trace)。Reaction が assistant_text の一部として transcript に残る          |
| CE-07 | **User Rhythm**: セッション中に観測する per-user 適応パラメータ(平均発話長、語速、EOT 前の間、barge-in 頻度)で endpointing/hold/grace/相槌間隔を調整。既定値は knowledge SSoT、永続化は personal tier(`knowledge/personal/`)                                               | 新規 `libs/core/interaction/user-rhythm.ts`、loop 配線                                                                      | rhythm 適応で hold/grace が個人差に追従することを workbench の「間の長い話者」シナリオで検証                              |
| CE-08 | **汎用 Interaction Controller 化**: エンジンを `libs/core/interaction/` に移し、音声固有の語を adapter に分離。`Observe → Infer → Decide → Act` の型を chat/co-session でも再利用可能にする(実装は voice adapter のみ、他は契約のみ)                                       | 新規 `libs/core/interaction/`、`libs/core/voice/` の再編                                                                    | voice 以外のイベント列(ダミー text adapter)を同じ機械に流せる                                                             |
| CE-09 | **Workbench/telemetry 拡張**: 相槌生成・意図分岐・rhythm 適応のシナリオ fixture 追加。`MediaEventBuffer` に turn state / signals を発行し、trace に `interaction.*` メトリクス追加                                                                                         | `voice-workbench.ts`、`tests/fixtures/voice-workbench/`、`realtime-media-session.ts`                                        | 新シナリオ全件 pass、`requires` 未充足は `skipped`(honesty contract 維持)                                                 |
| CE-10 | **文書・登録**: §13 契約を InteractionState/Signals/意図分岐で改訂、ops 手順書に新フラグ、env-registry・user-facing-vocabulary・語彙 schema への登録                                                                                                                       | `knowledge/product/architecture/realtime-media-session-architecture.md`、`realtime-voice-conversation-operations.md`        | `pnpm check` 系の登録系ゲート通過                                                                                         |

## 5. Wave 分割

| Wave | 内容                                  | 検証                                                        |
| ---- | ------------------------------------- | ----------------------------------------------------------- |
| W1   | CE-01, CE-02(基盤・等価リファクタ)    | 既存 workbench 全件 pass、§13 契約リグレッション、typecheck |
| W2   | CE-03, CE-04(シグナル・意図)          | 新シグナル/意図の workbench シナリオ、typecheck             |
| W3   | CE-05, CE-06(反応経路 — 体感差が最大) | TTFA 計測、相槌シナリオ、core vitest                        |
| W4   | CE-07, CE-09(適応・評価拡張)          | rhythm シナリオ、全 workbench                               |
| W5   | CE-08, CE-10(汎用化・文書)            | text adapter 契約テスト、`pnpm check`                       |

W1〜W3 が「会話してる感」を直接生む範囲。W5 の汎用化は voice が安定してからでも遅延可能。

## 6. ガードレール・非目標

- **ネイティブ音声モデルとの住み分け**: `gemini-live-client` 等の speech-to-speech モデルでは CE は「アダプタ越しの監視・メタ制御」に留まる。CE の主戦場はローカル STT→LLM→TTS カスケード。
- **fail-closed 維持**: consent・metered/battery 時の speculative 制限・相槌の頻度上限は既存ポリシーに従う。相槌生成が暴走しないよう最小間隔と 1 ターン上限を持つ。
- **非目標**: 感情音声合成・話者分離(会議側の管轄)・新規 TTS/STT エンジン導入・新言語の言語パックそのものの作成(ただし拡張機構は用意し、言語追加がデータ追加で済む構造にする — 日本語は既存パックとしてフル対応、英語も既存挙動を維持)。
- **LLM を反応経路に載せない**: Reaction/backchannel が reasoning backend に依存すると遅延と課金で破綻する。意図分類に軽量モデルを使う場合も推論 backend ではなく AFM 等のローカル seam。

## 7. 「AI が会社を動かす OS」との接続

CE-08 で抽象化する Interaction Controller は、音声会話と組織運営で共通の `Observe → Infer State → Decide Who Acts → Act` ループを単一の型で表す。`agent-communication-layer-model` / `mission-control-model` が持つ主導権判定(worker vs orchestrator、claim holder)と同型であり、Turn State は「誰が動く権利を持つか」の最小インスタンスとみなせる。本計画では voice adapter のみ実装し、chat( co-session / satellite bridge )や会議ファシリテーションへの展開は別計画とするが、型契約はその展開を塞がない形で定める。
