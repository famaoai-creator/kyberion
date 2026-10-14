---
category: Added
---

- **Realtime voice ↔ talking avatar** — `run_realtime_voice_conversation --interactive --avatar-follow` now plays reply segments through voice-hub (`POST /api/speech/play`) and reflects loop state to the presence surface, so the talking avatar tracks listening/thinking/speaking and mouths along via `/api/speech/state`. `--tts-engine <id>` overrides the reply TTS engine per call (e.g. `kokoro` for ~4 s/segment instead of ~20 s clone synthesis), and `KYBERION_CODEX_CLI_CWD` points `codex exec` at a neutral working directory to keep repo agent context out of conversational replies.
