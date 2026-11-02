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
- `speech_cpp`: MIT [speech.cpp](https://github.com/nyosegawa/speech.cpp) GGUF
  TTS (default `qwen3-tts-0.6b`) on Metal / Vulkan / CPU — cross-platform
  alternative to the MLX Qwen3 / Irodori Python bridges. Install the managed
  binary, then select `engine_id=speech_cpp` (or
  `pnpm kyberion speak --engine speech_cpp "…"`). First synthesis downloads
  the model into the OS speech.cpp cache. Override the catalog name with
  `KYBERION_SPEECH_CPP_TTS_MODEL`. Batch only today (`supports.streaming` is
  false; `pnpm kyberion speak --stream` still uses the MLX Qwen path).

Install and inspect all managed optional runtimes with:

```sh
pnpm kyberion voice setup
pnpm kyberion voice setup --apply
pnpm tool:setup -- --tool speech_cpp --apply
pnpm pipeline voice-health-check
```

Select a TTS engine through the existing voice selection command/API. For a
direct artifact smoke test, use the voice actuator with `engine_id=kokoro`,
`engine_id=pocket_tts`, or `engine_id=speech_cpp` after the runtime probe
reports `ready`.

## STT / VAD

- `faster_whisper`: Windows-friendly local Whisper Adapter. Set
  `KYBERION_WINDOWS_STT_BACKEND=faster_whisper` (or pass
  `stt_bridge_id=faster_whisper` to `verify_tts_loopback`). The bridge uses
  `KYBERION_STT_MODEL_DIR` for an offline CTranslate2 model, or
  `KYBERION_STT_MODEL` (default `small`) when model download is permitted.
  `KYBERION_STT_DEVICE=cuda` and `KYBERION_STT_COMPUTE_TYPE=float16` enable
  CUDA when the installed faster-whisper runtime supports it; CPU defaults to
  `int8`.

- `speech_cpp`: local ASR through the same managed `speech` binary (default
  `qwen3-asr-0.6b`). After `pnpm tool:setup -- --tool speech_cpp --apply`,
  `installAvailableSpeechToTextBridges` registers the `speech_cpp` bridge and
  voice-hub `auto` preference includes it when the binary is installed.
  Persist `stt_backend=speech_cpp` in voice selection preferences, or point
  voice-hub at an OpenAI-compatible serve with
  `KYBERION_SPEECH_CPP_URL=http://127.0.0.1:8095` (and optionally
  `KYBERION_SPEECH_CPP_AUTOSTART=1`). Loopback / `verify_tts_loopback` can use
  `stt_bridge_id=speech_cpp` (buffers PCM, then one `speech asr` pass).

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
