---
title: 音声・リアルタイム映像の技術再評価 2026-10
tags: [voice, realtime, tts, stt, vad, obs, avatar, memory]
last_updated: 2026-10-29
kind: architecture
scope: repository
authority: reference
role_affinity: [ecosystem_architect, implementer, reviewer]
---

# 音声・リアルタイム映像の技術再評価

## 判断と証拠の範囲

日本語会話は既存の Kokoro / Qwen3-TTS 0.6B と VAD、STT、割り込み処理を組み合わせる。
英語向けには 2026-10-20 公開の Pocket TTS Small を明示選択できるようにする。
小さいパラメーター数だけで、実プロセスの使用メモリ、音質、日本語性能を保証しない。

以下の「公式」は公開元の説明であり、この作業環境の実測ではない。
以前の [Apple Silicon の測定](local-voice-engine-findings.md) は 2026-10-13 時点の別測定であり、
今回再測定した数値として扱わない。今回は契約テストに加え、Pocket TTS Small 1.9Mの
実モデルを取得して、同一の短文を2回WAV生成した。聴取評価、streaming TTFA、長時間会話は未実施。

このcheckoutで `node --import ./scripts/ts-loader.mjs scripts/voice_setup.ts --tool pocket_tts --json`
を最初に実行した結果は `needs_install`、`pythonBin: null` だった。その後、同じスクリプトの
`--apply` で管理対象ランタイムをインストールし、`ready` を確認した。パッケージは `pocket-tts 4.0.1`。
実際の `TTSModel.load_model` に `language` 引数があることも確認した。
WhisperKit CLIはPATH上の実行ファイルとして検出されたが、
この検出を実音声の認識精度や使用メモリの確認とは扱わない。

### Small 1.9Mの実測

darwin/arm64で、既存 `renderNativeArtifact` と作業専用registry overlayを使い、
`model_id: english_2m_2026-10`、voice `alba`、英語の同一短文を生成した。
最初のsandbox実行はHub接続失敗・未キャッシュで終了し、ネットワーク権限を伴う再試行で成功した。
モデルはこの1.9Mのものだけを選び、通常群・Qwenの重みは取得していない。

| 測定                                | 初回成功（モデル取得を含む） | モデル取得済み・新規Pythonプロセス |
| ----------------------------------- | ---------------------------- | ---------------------------------- |
| artifact生成ヘルパーの経過時間      | 9.498秒                      | 2.264秒                            |
| Node起動も含むコマンド全体          | 9.94秒                       | 2.91秒                             |
| 生成音声長                          | 未測定                       | 4.320秒                            |
| artifact生成時間 / 音声長（RTF）    | 未算出                       | 0.524                              |
| コマンドのmaximum resident set size | 541,474,816 bytes            | 478,298,112 bytes                  |

経過時間は `performance.now()`、音声長は既存 `probeAudioDurationSec`、
RSSはmacOS `/usr/bin/time -l` でNodeとPython子プロセスを含むコマンドを測った値。
モデルだけの常駐メモリではなく、Python/Torch/Nodeなどの実行時負荷を含む。
2回目もPythonは新規起動であり、常駐workerのwarm推論ではない。
RTF 0.524はこの短文1件のartifact生成での結果で、初回PCMのTTFAや会話全体の遅延ではない。
主観音質や日本語会話の性能はこの結果から判断しない。

再確認用のregistry、WAVとJSON結果は作業証跡の
`active/shared/tmp/realtime-av-20261029/pocket-small/` に保存した。

## 音声候補の比較

| 候補             | 今回確認した公式情報                                                                     | 日本語と稼働条件                                                                                   | 採否                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pocket TTS Small | 2026年10月にデコーダー込み18.2M / 6.9M / 1.9Mを追加。単一CPUスレッドで最大25倍速との説明 | 新しいSmall群は英語。通常群の約200ms初回音声という説明をSmallの実測値に転用しない                  | **明示選択の橋渡しを採用**。既定は維持し、英語の省メモリ候補として比較する            |
| Kokoro 82M       | 既存の日本語ブリッジ、言語パックと辞書が必要                                             | 日本語の既存ローカル候補。速度とRSSは既存測定を参考に、同一ホストで再評価する                      | 継続利用。新規エンジン導入より先に既存経路を検証                                      |
| Qwen3-TTS 0.6B   | 既存の8-bit CustomVoiceとPCMストリーム経路あり                                           | 日本語対応。1.7Bクローン経路と小型ストリーム経路を分ける                                           | 継続利用。大きなモデルを会話の既定にしない                                            |
| Supertonic 3     | 99M、ONNX、31言語、日本語、44.1kHzの公開モデル                                           | 公式リポジトリは2026-09-09にアーカイブ。元の開発・サポートは終了。コードとモデルのライセンスは別   | 自動採用しない。保守引受、固定リビジョン、音質・依存性評価後に独立adapterとして再検討 |
| Qwen3-ASR 0.6B   | 日本語を含む30言語。streamingとofflineを提供。2026-06にTransformers標準サポートを追加    | 公式のストリーミング案内はvLLM経路。高並列スループットを、単一Mac会話の低遅延や低RSSの証拠にしない | STT比較候補。既存Whisperを未測定のまま置換しない                                      |
| TEN VAD          | 小さい計算量・メモリと低遅延を説明。リポジトリには既にNDJSONブリッジあり                 | 発話検出であり、音声認識やエコーキャンセルの代用にはならない                                       | 既存採用を維持。Sileroとの比較は誤割り込み率も測る                                    |

出典: [Pocket TTS公式README](https://github.com/kyutai-labs/pocket-tts)、
[Small公開日](https://kyutai.org/blog/2026-10-20-pocket-tts-small/)、
[Supertonic公式アーカイブ](https://github.com/supertone-oss-archive/supertonic)、
[Qwen3-ASR公式README](https://github.com/QwenLM/Qwen3-ASR)、
[TEN VAD公式README](https://github.com/TEN-framework/ten-vad)。

## 今回取り込む音声変更

`pocket_tts_bridge.py` は次の `model_id` だけを受け付ける。

- `kyutai/pocket-tts`: 従来どおり upstream の既定 `load_model()` を使う。
- `english`: upstream の既定英語configを明示する。
- `english_18m_2026-10` / `english_7m_2026-10` / `english_2m_2026-10`: upstream 同梱のSmall config。

既存の voice-engine registry の上書き設定で、`runtime_id: pocket_tts` のレコードの
`model_id` を上記の値に設定すると、artifact生成と再生の両経路から同じ選択値を渡す。
登録形式・指定先は既存の [voice engine registry](../governance/voice-engines/README.md) に従う。
通常の `pocket_tts` エンジンのモデルや日本語の既定は変更しない。
新configが入ったupstreamランタイムが必要で、旧ランタイムではエラーを返す。
今回の実生成は1.9Mのみで、6.9M・18.2Mの音声生成や比較はまだ行っていない。

任意のURLやYAMLパスは `model_id` として受け付けない。
モデル切替時に以前の音声状態を捨て、異なるモデルのテンソルを混ぜない。
同一モデルの音声状態キャッシュもLRUで最大8件に制限する。
件数上限は厳密なバイト上限ではなく、参照音声の長さやランタイム内部キャッシュも含めたRSS検証は別途必要。
このブリッジはWAV artifact生成であり、Smallを選ぶだけでKyberionのPCM streaming経路に登録されるわけではない。

## リアルタイム会話・映像で守る境界

低遅延はモデル単体では決まらない。VADの終話待ち、STT確定、LLMの初期トークン、
TTS初回PCM、再生バッファの時間を分けて測る。割り込みではTTS生成と再生キューの両方を止め、
再生音の回り込みで自分の声を認識しないようにする。

アバターは既存 `MediaEvent` の `audio_output_delta` と `animation_cue` を使い、
口形・表情と音声の時刻を共有する。録画済みMP4をOBSに流す既存経路と、
会話に追従するライブ描画は別の実行経路として検証する。
カメラのピクセル処理をTypeScriptで毎フレーム転送するより、OBS側のフィルタを使う構成を先に検討する。
フィルタ操作、カメラ公開、外部の配信開始はそれぞれ効果と承認を区別する。

## 次の実機比較

同じ英語・日本語の短文と長文を使い、cold/warm、TTFA、RTF、peak RSS、
30分連続動作、割り込み後の残音、誤検出率を記録する。
GPU/統合メモリを音声が占有した状態で映像FPSとLLM速度も測る。
日本語は読み間違い、固有名詞、数字、句読点、長文末尾の欠落を聴取確認する。
音声クローンは既存の本人同意とプロファイルの権限を維持する。
