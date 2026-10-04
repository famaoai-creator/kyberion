---
category: Added
---

- **Conversation Engine (opt-in)** — the realtime voice loop can now run a language-pack-driven conversation engine outside the LLM: agent backchannels spoken directly via the CE→TTS shortcut, instant reactions to pure hold requests (「ちょっと待って」), dropped replies to pure user backchannels, and user-rhythm timing adaptation. Enable with `--conversation-engine`, `--intent-shortcuts`, `--backchannel`, and/or `--rhythm` on `run_realtime_voice_conversation`. All off by default.
