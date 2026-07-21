# BlackHole 2ch TTS loopback 手順

この手順は、会議へ参加する前に `TTS → BlackHole 2ch → capture → STT` の音声経路を自己検証するためのものです。検証音声は既定で保存せず、receipt と品質指標だけを残します。

## 事前条件

1. macOSへ BlackHole 2ch をインストールする。
2. Audio MIDI Setupで入力・出力デバイスを確認する。Kyberionは設定を自動変更しない。
3. `pnpm meeting:preflight --mission <MISSION_ID> --json` を実行する。
4. microphone/audio input permission と録音・音声出力consentを明示的に許可する。
5. physical speakerを同時出力へ含める場合は、operatorが明示選択し安全な音量を確認する。

## 経路の確認

```bash
pnpm voice:route:list -- --json
pnpm voice:route:probe -- --device-label 'BlackHole 2ch' --json
```

永続設定には表示名ではなくCoreAudio device UIDを使用します。UIDが取得できない場合だけexact labelへfallbackし、substring一致やdevice indexの保存は行いません。同名候補が複数ある場合はblockedになります。

## loopback実行

実機テストは、preflightとoperator確認が済み、会議が未参加である場合だけ実行します。

```bash
KYBERION_LIVE_BLACKHOLE_TEST=1 pnpm voice:loopback:test -- \
  --bus blackhole \
  --text '音声経路の確認です' \
  --language ja \
  --voice-profile-id default \
  --confirm --json
```

出力receiptには、route UID、PCM format、TTS first audio、capture chunks/drops/RMS/clipping/silence、STT transcript/confidence、CER/WER/similarity、missing/unexpected spans、cleanup warningsを含めます。`source` は `self_tts_loopback` であり、会議transcriptへ渡しません。

CIでは `StubAudioBus` と決定的TTS/STTを使用します。live testのskipは成功扱いにせず、driver・権限・opt-in不足を理由として報告します。

## 自己音声を再認識する場合

会議runtimeは既定で半二重です。TTS再生中とpost-playback drain window中はBlackHole入力をSTT/agentへ渡しません。`--self-audio-suppression-ms`、`--post-playback-drain-ms`、`--barge-in-enabled` を調整できます。高度なAECは本機構に含めず、WebRTC Audio Processing等を別PRで評価します。

## 音がない・STTが空の場合

- input/output両方が同じBlackHole device UIDを指しているか確認する。
- sample rate、channels、`pcm_s16le` がTTS・CoreAudio output・captureで一致しているか確認する。
- CoreAudio output bridgeがUIDを解決できているか確認する。
- `captured audio is silent`、`TTS produced no audio`、`STT returned an empty final transcript` のreceipt理由を確認する。
- clippingやdropが閾値を超えた場合は、volume・buffer policy・device reconnectを確認する。

## 保持・停止・復旧

raw audioは既定で削除します。音声またはtranscriptを保持する場合はrequestで明示し、mission/tenant/tier配下のgoverned pathだけを使用します。SIGINT/SIGTERM、timeout、cancelではTTS、capture、output、process group、queue、device leaseを解放します。残ったleaseやorphan processは `pnpm doctor:meeting` で確認し、Audio MIDI設定変更やinstaller実行はoperatorが行います。
