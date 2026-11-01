---
category: Added
---

- **speech.cpp local voice runtime** — checksum-pinned managed tool/service (`speech_cpp`) for MIT ggml TTS/ASR on Metal/Vulkan/CPU. Voice engine `speech_cpp` synthesizes via `speech tts`; STT bridge `speech_cpp` transcribes via `speech asr`. Optional `speech serve` on `http://127.0.0.1:8095` (`KYBERION_SPEECH_CPP_URL`) feeds voice-hub’s OpenAI-compatible STT path; autostart is opt-in (`KYBERION_SPEECH_CPP_AUTOSTART`). Managed zip install extends `tool:setup` (`archive: zip`). Selection surfaces include voice-hub / speech-to-text / streaming-stt seams, persistable `stt_backend=speech_cpp`, and a loopback STT adapter for `verify_tts_loopback`.
