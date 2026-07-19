# Procedure: Realtime Voice Conversation

## Goal

Run a turn-based realtime voice conversation using:

- an `active` voice profile
- a configured speech-to-text bridge
- a configured reasoning backend
- governed voice generation for the assistant reply

The same runtime also exposes an interactive loop mode that records repeated turns,
transcribes each turn, and plays the assistant reply back through the local voice
stack.

This is the procedure behind the `live-voice` intent and its default execution profile:

- intent: `live-voice`
- execution profile: `voice-live-conversation-default`
- capability bundle: `realtime-voice-governed`

## Preconditions

- personal voice usage requires a registered and promoted `active` profile
- the active profile's sample refs should resolve under `active/shared/runtime/voice-profiles/<profile_id>/`
- strict mode rejects `shadow` profiles and clone-engine fallback
- `KYBERION_STT_COMMAND` should be configured unless transcript sidecars are used
- a reasoning backend should be available through `installReasoningBackends()`

## CLI

```bash
pnpm voice:conversation:turn \
  --session-id user-voice-live \
  --audio active/shared/tmp/live/user-turn-01.wav \
  --profile-id your-active-voice-profile \
  --language ja \
  --delivery-mode artifact_and_playback \
  --personal-voice-mode require_personal_voice
```

Interactive loop mode (the default) runs the full-duplex realtime loop:
each turn starts when you begin speaking and ends automatically after ~700ms of
silence (VAD endpoint), the reply is synthesized **sentence-by-sentence** so the
first audio starts fast, and per-turn latency metrics (stt/llm/first-audio) are
printed for every exchange.

Interactive recording requires a mission-scoped `voice-consent.json`; grant it
before starting the microphone session:

```bash
pnpm meeting:consent grant --mission MSN-LIVE-VOICE-001
```

```bash
pnpm voice:conversation:turn -- \
  --interactive \
  --session-id user-voice-live \
  --profile-id your-active-voice-profile \
  --language ja \
  --mission MSN-LIVE-VOICE-001 \
  --turns 3
```

Realtime loop flags (all optional):

- `--barge-in` — interrupt the assistant by speaking over it (opt-in; a headset
  is recommended, speaker echo can false-trigger; detection uses an elevated
  threshold + 250ms sustained-speech debounce)
- `--vad-backend silero` — neural VAD via the Python bridge; requires
  `KYBERION_SILERO_VAD_MODEL` (path to a silero_vad `.onnx`) and onnxruntime in
  the Python env. Falls back to `energy` with an explicit warning. Also
  selectable via `KYBERION_VAD`.
- `--vad-endpoint-ms 700` — silence that ends an utterance
- `--vad-threshold <rms>` — explicit speech threshold; omitted → auto-calibrated
  from a ~500ms noise-floor sample
- `--max-utterance-seconds 30` — safety cap per utterance
- `--mic-device ":0"` — avfoundation index (macOS) / ALSA device (Linux)
- `--no-streaming-stt` — disable in-utterance streaming transcription (used when
  `KYBERION_STT_COMMAND` is configured; batch STT on the turn WAV is the fallback)
- `--no-warm-actuator` — spawn the voice actuator per segment instead of keeping
  one resident `--serve` process
- `--mission MSN-...` — required recording consent gate (fail-closed, same
  `voice-consent.json` evidence contract as meeting participation)
- `--idle-timeout-seconds 120` — end the loop after continuous silence

The VAD recorder needs `ffmpeg` (macOS) or `arecord` (Linux) on PATH, and
playback is used only with `--delivery-mode artifact_and_playback` and needs
`afplay` / `aplay`. `--delivery-mode artifact` writes audio without playing it.
The legacy fixed-duration recorder remains available as a fallback:

```bash
pnpm voice:conversation:turn -- \
  --interactive \
  --recorder fixed \
  --record-seconds 8 \
  --session-id user-voice-live \
  --mission MSN-LIVE-VOICE-001 \
  --turns 3
```

If you need the recorder to capture from a different local setup, set:

- `KYBERION_PYTHON_BIN` for the Python bridge runner (fixed recorder only)
- `KYBERION_STT_COMMAND` for the speech-to-text backend

## Result

The command writes:

- session transcript:
  - `active/shared/runtime/realtime-voice-conversations/<session_id>.json`
- optional reply artifact:
  - `active/shared/tmp/realtime-voice-conversation/<request_id>.wav`
- interactive recording cache:
  - `active/shared/tmp/realtime-voice-conversation-recordings/<session_id>/turn-XX.wav`

Returned payload includes:

- transcribed user text
- assistant reply text
- voice generation result
- presence timelines for ingress and reply

## Important Constraint

This runtime enables governed turn-based live conversation.
It does not itself train or promote a voice profile.

If the user says `use my voice`, registration and promotion still have to happen first via:

- [register-voice-profile.md](/Users/famao/kyberion/knowledge/public/procedures/media/register-voice-profile.md)
- [promote-voice-profile.md](/Users/famao/kyberion/knowledge/public/procedures/media/promote-voice-profile.md)

After promotion, the runtime will read the registered profile from `active/shared/runtime/voice-profiles/<profile_id>/` through the voice profile registry.

## Related Procedures

- [`transcribe-audio-from-asset.md`](/Users/famao/kyberion/knowledge/public/procedures/media/transcribe-audio-from-asset.md) covers batch transcription without the live turn-taking loop.
- [`generate-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/generate-video-from-adf.md) covers prompt-based video generation.
