#!/bin/sh
# Persistent framed streaming TTS worker for the cloned voice.
#
# Wraps qwen3_tts_stream_bridge.py --stream-framed: newline text on stdin,
# length-prefixed PCM frames on stdout (uint32be + payload, zero-length
# end-of-request per line). With KYBERION_TTS_PERSISTENT=1 the shell bridge
# keeps this process resident, so the 1.7B Base model loads once per session.
#
#   KYBERION_TTS_COMMAND=<repo>/libs/actuators/voice-actuator/scripts/qwen3_clone_framed_stream.sh
#   KYBERION_TTS_PERSISTENT=1
#   KYBERION_TTS_SAMPLE_RATE_HZ=16000        # bridge emits 16 kHz by default
#
# Reference voice resolves from KYBERION_VOICE_PROFILE_ID (injected by the
# bridge) → first sample_ref in knowledge/personal/voice/profile-registry.json
# and its .transcript.txt sidecar. KYBERION_QWEN3_REF_AUDIO / REF_TEXT /
# MODEL_ID override it.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

PY="${KYBERION_QWEN3_PYTHON:-$ROOT/active/shared/runtime/tool-runtimes/mlx-audio/bin/python3}"
BRIDGE="$HERE/qwen3_tts_stream_bridge.py"
MODEL_ID="${KYBERION_QWEN3_MODEL_ID:-mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit}"
PROFILE_ID="${KYBERION_VOICE_PROFILE_ID:-}"
REGISTRY="$ROOT/knowledge/personal/voice/profile-registry.json"

REF_AUDIO="${KYBERION_QWEN3_REF_AUDIO:-}"
REF_TEXT="${KYBERION_QWEN3_REF_TEXT:-}"

if [ -z "$REF_AUDIO" ] && [ -n "$PROFILE_ID" ] && [ -f "$REGISTRY" ]; then
  REF_AUDIO=$("$PY" - "$REGISTRY" "$PROFILE_ID" <<'EOF'
import json, sys
registry = json.load(open(sys.argv[1]))
for profile in registry.get('profiles', []):
    if profile.get('profile_id') == sys.argv[2] and profile.get('status') == 'active':
        refs = profile.get('sample_refs') or []
        print(refs[0] if refs else '')
        break
EOF
)
fi
[ -n "$REF_AUDIO" ] || { echo "no ref audio: set KYBERION_QWEN3_REF_AUDIO or KYBERION_VOICE_PROFILE_ID" >&2; exit 1; }
case "$REF_AUDIO" in /*) ;; *) REF_AUDIO="$ROOT/$REF_AUDIO" ;; esac
[ -f "$REF_AUDIO" ] || { echo "ref audio missing: $REF_AUDIO" >&2; exit 1; }
if [ -z "$REF_TEXT" ]; then
  for cand in "$REF_AUDIO.transcript.txt" "${REF_AUDIO%.wav}.transcript.txt"; do
    [ -f "$cand" ] && REF_TEXT="$cand" && break
  done
fi
[ -n "$REF_TEXT" ] && [ -f "$REF_TEXT" ] || { echo "ref transcript missing for $REF_AUDIO" >&2; exit 1; }

exec "$PY" "$BRIDGE" --stream-framed --model-id "$MODEL_ID" \
  --mlx-memory-limit-gb "${KYBERION_QWEN3_MEMORY_LIMIT_GB:-8}" \
  --ref-audio "$REF_AUDIO" --ref-text "$REF_TEXT"
