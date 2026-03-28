# Voice Hub

Local voice ingress for Kyberion. The current flow is:

1. capture microphone audio once
2. transcribe it with a configurable STT backend
3. route the text through `presence-surface-agent`
4. speak the reply with the host TTS

## STT backends

`voice-hub` now supports a small provider abstraction.

- `server`
  - Any OpenAI-compatible transcription endpoint
  - Recommended first target because it works with `WhisperKit Local Server`, `mlx-audio`, and similar local runtimes
- `whisper_cpp`
  - Local file transcription via `whisper.cpp`
- `native_speech`
  - Apple Speech live recognition fallback

## Recommended setup

Use a local OpenAI-compatible STT server first.

### WhisperKit example

Set:

```bash
export WHISPERKIT_BASE_URL=http://127.0.0.1:8080
export WHISPERKIT_MODEL=openai_whisper-large-v3
export VOICE_HUB_STT_PREFERENCE=server,whisper_cpp,native_speech
```

### Generic OpenAI-compatible server

Set:

```bash
export VOICE_HUB_STT_BASE_URL=http://127.0.0.1:8000
export VOICE_HUB_STT_MODEL=mlx-community/whisper-large-v3-turbo-asr-fp16
export VOICE_HUB_STT_PREFERENCE=server,whisper_cpp,native_speech
```

## Runtime APIs

- `GET /api/stt/backends`
  - Returns available backends and the currently selected order
- `GET /api/input-devices`
  - Returns available microphone devices
- `POST /api/listen-once`
  - Runs one capture -> transcription -> reply cycle

Example:

```bash
curl -X POST http://127.0.0.1:3032/api/listen-once \
  -H 'Content-Type: application/json' \
  -d '{
    "locale": "ja-JP",
    "backend": "server",
    "timeout_seconds": 6,
    "auto_reply": true
  }'
```
