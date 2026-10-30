---
title: 位置・時刻・変化を持つ知覚の利用と検証
tags: [perception, vision, audio, video, diarization, tracking, semantic-search]
last_updated: 2026-10-30
role_affinity: [ecosystem_architect, researcher, analyst, operator]
phase_affinity: [alignment, execution, review]
---

# 位置・時刻・変化を持つ知覚

see / listen / watch のファイル入力を拡張する。既存のMarkdownを維持し、追加認識は明示オプションで選択する。構造を扱う場合は --json を使用する。入力をリポジトリ内に置き、対象tenantのscopeを先に確立する。scopeは現在のruntime authorityを使用する。

## 入口

以下のモデルパスはoperatorが導入するローカル資産の例。

```bash
pnpm kyberion see active/shared/staging/public/shared/card.png --grounded --json
pnpm kyberion see active/shared/staging/public/shared/after.png --compare active/shared/staging/public/shared/before.png --json
pnpm kyberion watch active/shared/staging/public/shared/demo.mp4 --changes --every 1 --max-frames 120 --json
pnpm kyberion listen active/shared/staging/public/shared/meeting.wav --diarize --diarization-model active/shared/cache/system/perception-models/community-1 --timestamps --json
pnpm kyberion listen active/shared/staging/public/shared/sounds.wav --events --audio-model active/shared/cache/system/perception-models/yamnet.tflite --no-transcript --json
pnpm kyberion see active/shared/staging/public/shared/person.jpg --no-ocr --track --face-model active/shared/cache/system/perception-models/face_landmarker.task --pose-model active/shared/cache/system/perception-models/pose_landmarker_lite.task --gesture-model active/shared/cache/system/perception-models/gesture_recognizer.task --avatar-id presenter --json
pnpm kyberion watch active/shared/staging/public/shared/demo.mp4 --index demo --embedding-model active/shared/cache/system/perception-models/clip-vit-base-patch32 --json
pnpm kyberion see --search "a person showing a document" --index demo --embedding-model active/shared/cache/system/perception-models/clip-vit-base-patch32 --json
```

watchでも --diarize / --events / --no-transcript / --track / --avatar-id を使える。--no-audio と音声解析は併用不可。--python <実行ファイル> で隔離Pythonを指定する。認識できない場合はエラーを返し、架空の成功結果へのフォールバックはしない。

## 観測と根拠

--grounded または追加認識を選ぶと observations を返す。sourceには元ファイル・SHA-256・tier / tenant、観測にはprovider・kind・finalityを持つ。OCR領域は左上原点の0..1座標。時間は秒単位。動画のサンプル位置は basis: sampled、trackingはデコーダ由来の basis: decoded として区別する。入力のhash計算中と認識後に変更を検出すれば公開を拒否する。不変スナップショット方式ではないので認識中の入力は変更しない。

話者は匿名のセッション内ラベルで、本人確認ではない。帰属は tentative とし、重複発話の speaker_ids を保持する。STTに時刻情報がない場合は話者区間を別途返し、テキストとの対応付け不可を警告する。音イベント区間は分類窓であり、正確な発生・終了時刻ではない。

## 環境とモデル

```bash
uv venv --python 3.12 active/shared/cache/system/perception-runtime
uv pip install --python active/shared/cache/system/perception-runtime/bin/python -r libs/core/perception/requirements.txt
```

以降は --python active/shared/cache/system/perception-runtime/bin/python を付ける。ランタイムはモデルも依存関係も自動取得しない。公開モデル資産はsystem cacheに導入できるが、利用者データ・索引はtier / tenant partitionに置く。

- [MediaPipe音分類](https://developers.google.com/edge/mediapipe/solutions/audio/audio_classifier): metadata付きYAMNet TFLite。
- [MediaPipe顔認識](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker): face_landmarker.task。姿勢・手gestureには各Tasksモデルを指定する。
- [Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1): operatorがモデル条件へ同意して一式を準備し、pyannote.audio 4系を別途導入する。バンドルは config.yaml と segmentation / embedding / plda サブフォルダを含め、モデル参照を $model/segmentation、$model/embedding、$model/plda とする。組み込みSpeakerDiarization pipelineのみを許可し、外部参照と動的クラスを拒否する。
- [CLIP](https://huggingface.co/openai/clip-vit-base-patch32): 検証revisionは d2bce4bc6684fb94eb627c995ba3164d618ef0f7。組み込みTransformers CLIP / SigLIP / SigLIP2とsafetensorsに対応し、remote_codeとpickle重みを使用しない。検索言語はモデル次第で、英語CLIPの確認を日本語品質の証明にしない。文脈長超過の問い合わせは拒否する。

## 変化とライブ

see --compare は同じ実効scopeの画像同士を比較する。watch --changes は32x32色差・perceptual hashを使い、最後に採用したフレームとの差を比較する。緩やかな累積変化も対象になる。比較はデコード前に寸法確認できるPNG / JPEG / BMPが対象。全画素の厳密差分や意味的な物体追跡を保証しない。

CLIのwatchは録画のバッチ処理。ライブはcoreの openTrackingSession / trackFrameStream に、capture / recordの権限を通したフレームのAsyncIterableを接続する。一つのresident Pythonでモデルを保持し、処理は一件ずつで上流にbackpressureをかける。AbortSignal / deadline / closeで認識プロセスを終了する。capture資源の停止はproducerの責任。trackingFrameToAnimationCuesは既存のavatar cueを返し、描画・配信はmedia session / presenceの所有者が行う。カメラ起動・配信開始は認識コマンドの副作用にしない。

## 索引と制限

--index は同名索引を原子的に再構築し、暗黙追記はしない。動画はサンプル画像のベクトルと元動画・時刻を保存し、中間フレームのパスは保存しない。モデル資産hash・次元・元入力hashを照合し、変更時は再構築を要求する。runtime scopeとの完全一致を要求し、最大512項目・4096次元・32MiB・TTL最大7日。期限切れは検索拒否。動画の位置はサンプル位置であり、厳密なイベント時刻の推論ではない。

2026-10-30の実機確認: YAMNetで4秒の公式音声のSpeech/Silence、MediaPipeで顔1・姿勢1・blendshape52個とavatar cue、resident 2フレーム、録画3フレームのデコード時刻、CLIPで人物画像index/queryと対照問い合わせを確認した。単一fixtureの動作確認であり、一般精度・最大RSS・実カメラFPSの証明ではない。Community-1実推論、正の手gesture fixture、日本語検索品質は未検証。
