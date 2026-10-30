---
title: リアルタイム会話のstreaming設定と解除
tags: [voice, realtime, streaming, configuration]
last_updated: 2026-10-31
---

# Streaming設定の保存と確認

設定は現在のoperator profileに保存される。interactive/VADのstreaming経路だけに使い、batch STTの設定やprocess.envを変更しない。各起動で明示された環境変数、保存設定、組み込み既定値の順に解決する。

```bash
pnpm voice:conversation-config set --stt-command python --stt-args=stt-wrapper.py,--language,ja --tts-command python --tts-args=tts-wrapper.py --tts-sample-rate 24000
pnpm voice:conversation-config show
```

STT/TTS commandは内部に空白を含まない単一の実行ファイル名、argsはcomma-separated argv。値がハイフンで始まる場合は `--stt-args=--foo,--bar` のようにequal形式で渡す。play-commandは実行ファイルを先頭にしたcomma-separated argvで、既存の実行guardを通る。コマンドは空白のみ・NUL・改行を拒否し、サンプルレートは16000/24000/48000Hz。実際のPCM出力レートに合わせる。環境変数で上書きする名前は `KYBERION_TTS_SAMPLE_RATE_HZ`。既定のTTS bridgeはraw PCM出力を読む。framed出力のpersistent wrapperを使う場合だけ、wrapperの形式と `KYBERION_TTS_PERSISTENT=1` を一致させる。

# 一部の設定だけを解除する

```bash
pnpm voice:conversation-config unset tts-command tts-args tts-sample-rate --dry-run
pnpm voice:conversation-config unset tts-command tts-args tts-sample-rate
```

unsetで指定できるのはstt-command/stt-args/tts-command/tts-args/tts-play-command/tts-sample-rate。選択した保存値だけを削除し、声・persona・reasoning設定は維持する。環境変数自体は解除しない。全体を既定値に戻すときだけresetを使う。set/unsetのdry-runも保存時と同じ検証を行い、profileには書き込まない。showと通常の更新結果にstreaming項目も表示される。
