---
title: Realtime voice conversation operations
tags: [voice, realtime, conversation, model-selection, voice-profile, operations]
last_updated: 2026-09-26
---

# Realtime voice conversation operations

Kyberion の realtime 音声会話は、録音用 pipeline ではなく、セッションを
持つ機能として次のターン境界を実行する。

```text
設定解決
  -> recording consent / device preflight
  -> VAD が発話区間を確定
  -> streaming STT が音声を文字へ変換
  -> reasoning backend が短い返答を生成
  -> provider の text delta を文単位に flush
  -> voice profile の TTS で合成
  -> playback / artifact delivery
  -> transcript と latency を session evidence に保存
```

## 初期設定

設定はオペレーターの active profile 配下の
`onboarding/realtime-voice.json` に保存される。個人音声サンプルや
provider credential はこのファイルにはコピーしない。

最初は安全なローカル音声と fallback を選び、会話を起動する。

```sh
pnpm voice:conversation-config set \
  --voice-profile-id operator-ja-default \
  --language ja \
  --assistant-name Kyberion \
  --latency-profile low_latency \
  --personal-voice-mode allow_fallback \
  --delivery-mode artifact_and_playback

pnpm voice:conversation-config show --json
```

実際にマイクで話すには、mission の recording consent を先に通し、
セッションごとに新しい `--session-id` を付ける。

```sh
KYBERION_PERSONA=ecosystem_architect \
MISSION_ID=MSN-... \
node dist/scripts/run_realtime_voice_conversation.js \
  --session-id realtime-voice-$(date +%Y%m%d-%H%M%S) \
  --interactive --turns 10 --mission MSN-... \
  --recorder vad --latency-profile low_latency \
  --personal-voice-mode allow_fallback
```

`low_latency` は `model_tier=fast`、`effort=low`、VAD endpoint 500 ms、
短い TTS flush を既定にする。検討や長めの応答を優先する場合は
`--latency-profile balanced` を使う。

## ターンテイキング(割り込み・保留・応答ゲート)

VAD 会話ループは次のフラグでターンの取り方を切り替える。挙動の契約は
[realtime-media-session-architecture §13](../architecture/realtime-media-session-architecture.md#13-turn-taking-contract-2026-09-24)
にある。

| フラグ                                   | 既定                                                                      | 内容                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--barge-in-mode off\|legacy\|two_stage` | `low_latency` かつ streaming STT が使えるとき `two_stage`、それ以外 `off` | `two_stage` は発話検知で再生を一時停止し、streaming STT の partial に語があれば停止、エコーや語の無い雑音なら再開する。`legacy` は持続音声で即停止(`--barge-in` と同じ)。`KYBERION_VOICE_BARGE_IN_MODE` が指定されていればそれが優先する |
| `--eot-hold` / `--no-eot-hold`           | 有効                                                                      | 「〜て」「〜けど」「えーと」や and/but で終わる発話を保留し、次の発話とつなげて 1 ターンにする。1.5 秒話さなければ確定する                                                                                                               |
| `--respond-gate` / `--no-respond-gate`   | 有効                                                                      | フィラーだけの発話には応答しない。barge-in が有効なときは、自分の TTS がマイクに回り込んだエコーにも応答しない                                                                                                                           |
| `--speculative-reply`                    | `KYBERION_VOICE_SPECULATIVE_REPLY=1` のときだけ有効                       | 発話中の短い無音(250 ms)で推論を先に始め、生成はバッファだけする。確定した文字起こしが一致したときだけ再生し、話し続けたら中止する。streaming STT が必要。battery / metered では無効                                                     |
| `--first-phrase-cache`                   | 無効                                                                      | 返答の最初のフレーズの合成音声を `active/shared/runtime/voice-first-phrase-cache` に保存して再利用する。キーは engine・voice・profile の改訂・設定・本文                                                                                 |

```sh
node dist/scripts/run_realtime_voice_conversation.js \
  --session-id realtime-voice-$(date +%Y%m%d-%H%M%S) \
  --interactive --mission MSN-... \
  --barge-in-mode two_stage --speculative-reply
```

スピーカーで聞く場合、`two_stage` でもエコーで一時停止が起きることがある。
ヘッドセットを推奨する。割り込みで中止したターンの理由(`barge_in`、
`external` など)はループのイベントと trace の
`realtime_voice.turn_cancelled` に出る。

`two_stage` の一時停止は、既定のプレイヤー(afplay/aplay)では POSIX の
SIGSTOP/SIGCONT でプレイヤー process をその場で止めて再開するため、再開時に
今の文が最初から再生し直されることはない。win32、またはカスタム `play()` が
pause/resume を実装していない場合のみ、停止して次の再開時に文を再生し直す
フォールバックになる。`pause()` が SIGSTOP の送達失敗を報告した場合(既に
終了した process など)も同じ停止・再生し直しフォールバックになり、無音が
起きたと誤認しない。

SIGSTOP は spawn した子 process 自身にしか届かない。カスタム `command` が
`sh -c '...'` のようにシェル経由で実プレイヤーを起動している場合、止まるのは
シェルだけで、シェルが起動した孫 process(実プレイヤー)は鳴り続ける ——
シェルラップを挟むカスタムコマンドを使うときは注意すること。

## モデル・effort の変更

変更は次の会話から使う。CLI の一時指定は保存設定より優先する。

```sh
# 現在の provider が Codex CLI の場合の例
pnpm voice:conversation-config set \
  --reasoning-model gpt-5.6-luna \
  --reasoning-model-tier fast \
  --reasoning-effort low

# tier に任せ、provider の構成済みモデルを使う
pnpm voice:conversation-config set \
  --latency-profile balanced \
  --reasoning-model-tier standard \
  --reasoning-effort medium
```

`reasoning_model` は active reasoning provider のモデル ID と一致させる。
たとえば `gpt-5.6-luna` は Codex CLI に対する指定であり、Grok/Claude の
セッションにそのまま流用しない。provider の切り替えは既存の
`reasoning:config` / `reasoning:setup` の governed route で行う。

モデル指定の優先順位は次の通り。

```text
run CLI flags > realtime-voice.json > latency profile > provider default
```

対応 provider は exact model、model tier、effort を adapter 境界で CLI/API
へ投影する。対応していない provider は provider default または既存の
stream fallback を使い、未検証の CLI 引数を自由に渡さない。

## 利用する音声の変更

音声は `voice_profile_id` で選ぶ。voice profile は voice-engine registry と
consent / personal-voice policy に従うため、任意のファイルパスや任意の
voice ID を直接 TTS に渡さない。

```sh
# 登録済みの個人音声を使う場合
pnpm voice:conversation-config set \
  --voice-profile-id my-voice-v2 \
  --personal-voice-mode require_personal_voice

# 個人音声が準備できていない間は governed fallback を許可
pnpm voice:conversation-config set \
  --voice-profile-id operator-ja-default \
  --personal-voice-mode allow_fallback
```

voice profile は会話セッション開始時に session へ固定する。したがって
音声を変えたときは既存セッションを再利用せず、新しい `--session-id` を
開始する。同じ session id では、会話の声がターン途中で変わらないことを
優先する。モデルと effort はターンごとの reasoning option なので、設定を
更新した後の次ターンから反映できる。

## 確認・復旧

```sh
pnpm voice:conversation-config show
pnpm voice:conversation-config set --reasoning-effort low --dry-run
pnpm voice:conversation-config reset
pnpm kyberion voice setup --json
pnpm pipeline voice-health-check
```

`reset` は profile registry の active profile、`ja`、`Kyberion`、
`low_latency`、`allow_fallback`、artifact + playback に戻す。設定変更は
個人 profile の onboarding 設定だけを変更し、voice profile registry、
mission transcript、provider credential は変更しない。

## 会議・アバターとの境界

この設定は一人の会話 front の assistant voice を定義する。複数人会議では
参加者ごとの speaker identity、発話区間、話者分離、議事録を meeting session
側で管理し、assistant の返答だけをこの voice profile へ渡す。VibeVoice や
viseme、avatar の口形同期を追加する場合も、`voice_profile_id` は音声の
identity、`speech timing / viseme stream` は presentation timeline、avatar
driver は表示 actuator として分離する。

この分離により、会議の話者音声を assistant の clone profile と混ぜず、
avatar 表現を変えても consent と音声選択の監査境界を維持できる。

## Voice actuator と media session の接続

realtime loop は `RealtimeMediaSession` の canonical event sink を 1 セッション
1 バッファで持つ。入力側は `speech_started`、`speech_ended`、
`transcript_final`、出力側は `assistant_text_delta`、`audio_output_delta`、
`turn_completed`、最後に `session_ended` を発行する。会話 runner は
`assistant` mode の human / agent participant を検証してからこの sink を
接続するため、meeting / avatar projection は同じ `MediaEvent` を購読できる。

通常の artifact 経路では `voice-actuator` の `generate_voice` を使い、
`profile_ref.profile_id`、`engine.engine_id`、language、delivery mode、
personal-voice policy を 1 つの governed payload として渡す。生成された
assistant artifact は会話 transcript の `audio_ref` に記録する。直接 PCM の
streaming TTS を選んだ場合は voice-actuator artifact を迂回するため、
`audio_output_delta` は stream bridge の出力として発行され、profile ID は
bridge へ明示的に渡される。

同じ session id で voice profile、language、assistant name、system prompt を
変更することは拒否される。これは設定更新後に古い session が別の声で続く
事故を防ぐためである。モデルと effort は transcript を維持したまま次の
reasoning turn へ変更できる。
