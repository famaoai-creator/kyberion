# Audio routing architecture

Kyberionの音声経路は、engineとOS deviceを分離したport/route構造です。

```text
TtsSource → AudioOutputPort(CoreAudio UID) → BlackHole 2ch
BlackHole 2ch → AudioInputPort(FFmpeg AVFoundation capture) → StreamingSttPort
                                      ↓
                              LoopbackVerifier → receipt
```

`libs/core` がPCM入出力、format negotiation、bounded queue、process lifecycle、health、device leaseを所有します。TTS/STT backendは既存registry/bridgeから選択し、voice actuatorがverification契約、validation、trace、receiptを公開します。

## macOS output

FFmpeg AVFoundation outputは正規経路ではありません。現行実機特性化では、FFmpeg listingがstderrへデバイスを出すこと、exit codeだけではPCM deliveryを保証できないことを固定し、出力は `coreaudio-output-bridge.swift` のAudioQueueへ置き換えました。指定UIDを直接開き、macOSのdefault outputを変更しません。sample rate、channels、encodingが不一致なら暗黙変換せず拒否します。

capture側のみFFmpeg AVFoundationを使用します。デバイスはCoreAudio inventoryでUID優先、exact label fallback、ambiguous failureの順に解決します。device indexは保存しません。

## Buffer/process/lease

入力はbounded ring bufferです。既定overflow policyは `drop_oldest` で、drop countとdrop durationをmetrics/receiptへ記録します。child processはsafe environment、固定binary、サイズ制限付きstderr、process group単位のgraceful stop→hard killを使います。UIDごとにfile-backed leaseを取得し、heartbeat、TTL、stale recoveryを行います。

## Meeting mode

loopback verificationのSTT結果は内部比較だけに使い、meeting transcriptへ送信しません。meeting runtimeはLISTENING/SPEAKING/DRAININGを分離し、self TTSの再送を抑制します。barge-in/AECは別責務です。
