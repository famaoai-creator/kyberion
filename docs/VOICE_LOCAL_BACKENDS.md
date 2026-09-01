# Local Voice Backend Setup

Kyberion now exposes optional local voice engines through the existing governed
voice selection and subprocess contracts. The default remains the host-native
voice path; optional runtimes are only selected after their health probe passes.

## TTS

- `kokoro`: lightweight local TTS. The bridge accepts Japanese (`ja`) when the
  installed Kokoro language pack provides `j` voices such as `jf_alpha`.
- `pocket_tts`: CPU streaming TTS and consent-gated voice cloning. The current
  upstream language packs are English, French, German, Portuguese, Italian,
  and Spanish; Japanese requests must use Kokoro or Apple Speech instead.

Install and inspect all managed optional runtimes with:

```sh
pnpm kyberion voice setup
pnpm kyberion voice setup --apply
pnpm pipeline voice-health-check
```

Select a TTS engine through the existing voice selection command/API. For a
direct artifact smoke test, use the voice actuator with `engine_id=kokoro` or
`engine_id=pocket_tts` after the runtime probe reports `ready`.

## STT / VAD

- `faster_whisper`: Windows-friendly local Whisper Adapter. Set
  `KYBERION_WINDOWS_STT_BACKEND=faster_whisper` (or pass
  `stt_bridge_id=faster_whisper` to `verify_tts_loopback`). The bridge uses
  `KYBERION_STT_MODEL_DIR` for an offline CTranslate2 model, or
  `KYBERION_STT_MODEL` (default `small`) when model download is permitted.
  `KYBERION_STT_DEVICE=cuda` and `KYBERION_STT_COMPUTE_TYPE=float16` enable
  CUDA when the installed faster-whisper runtime supports it; CPU defaults to
  `int8`.

- `fluid_audio`: a local Parakeet bridge for macOS. Set
  `KYBERION_FLUID_AUDIO_STT_COMMAND` to the bundled Swift Package bridge (or
  another compatible command). The bundled command accepts
  `{{audio}}`/`{{language}}` and prints JSON `{ "text": "..." }`:

  ```sh
  export KYBERION_FLUID_AUDIO_STT_COMMAND='swift run --package-path satellites/fluid-audio-cli fluidaudio-bridge transcribe "{{audio}}" --language "{{language}}"'
  ```

  The same command can be replaced by a streaming implementation through
  `KYBERION_STT_COMMAND` when it implements the streaming bridge contract.

- `ten_vad`: optional 10/16 ms-hop VAD selected with `KYBERION_VAD=ten_vad`.
- `silero`: optional ONNX VAD selected with `KYBERION_VAD=silero`. Install a
  current Silero VAD v6.2-compatible ONNX model, then set
  `KYBERION_SILERO_VAD_MODEL` to its path. The TypeScript side falls back to
  Energy VAD and reports the degradation reason if the optional runtime fails.

The command boundary keeps Swift/third-party package lifecycle outside the
Kyberion TypeScript bundle while still making availability, selection, and
failure behavior observable and testable.
