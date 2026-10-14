#!/bin/sh
# Streaming TTS seam for KYBERION_TTS_COMMAND.
#
# Reads newline-delimited UTF-8 text on stdin and emits raw PCM on stdout —
# the shell streaming-TTS bridge contract. Audio comes from piper-plus
# (ayutaz/piper-plus, ja-capable ONNX TTS) and is resampled from the model's
# native 22050 Hz to a governed rate via ffmpeg.
#
#   KYBERION_TTS_COMMAND=<repo>/libs/actuators/voice-actuator/scripts/piper_plus_pcm_stream.sh
#   KYBERION_TTS_SAMPLE_RATE_HZ=24000
#
# Env (defaults resolve this repo's managed runtime/cache layout; the bridge
# spawns with a sanitised env, so do not rely on exports reaching here):
#   KYBERION_PIPER_BIN       piper-plus executable
#   KYBERION_PIPER_MODEL     .onnx model path
#   KYBERION_PIPER_RATE      model's native sample rate (default: 22050)
#   KYBERION_PIPER_OUT_RATE  emitted rate — 16000|24000|48000, matching
#                            KYBERION_TTS_SAMPLE_RATE_HZ (default: 24000)
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

PIPER_BIN="${KYBERION_PIPER_BIN:-$ROOT/active/shared/runtime/tool-runtimes/piper-plus/piper-plus/bin/piper-plus}"
PIPER_MODEL="${KYBERION_PIPER_MODEL:-$ROOT/active/shared/cache/system/piper-plus/models/tsukuyomi/tsukuyomi-chan-6lang-fp16.onnx}"
IN_RATE="${KYBERION_PIPER_RATE:-22050}"
OUT_RATE="${KYBERION_PIPER_OUT_RATE:-24000}"

[ -x "$PIPER_BIN" ] || { echo "piper-plus not executable: $PIPER_BIN" >&2; exit 1; }
[ -f "$PIPER_MODEL" ] || { echo "piper model missing: $PIPER_MODEL" >&2; exit 1; }

exec "$PIPER_BIN" --model "$PIPER_MODEL" --output_raw 2>/dev/null |
  ffmpeg -v error -f s16le -ar "$IN_RATE" -ac 1 -i pipe:0 -f s16le -ar "$OUT_RATE" -ac 1 pipe:1
