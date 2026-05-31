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

Interactive loop mode:

```bash
pnpm voice:conversation:turn -- \
  --interactive \
  --session-id user-voice-live \
  --profile-id your-active-voice-profile \
  --language ja \
  --record-seconds 8 \
  --turns 3
```

If you need the recorder to capture from a different local setup, set:

- `KYBERION_PYTHON_BIN` for the Python bridge runner
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

## Related Procedures

- [`transcribe-audio-from-asset.md`](/Users/famao/kyberion/knowledge/public/procedures/media/transcribe-audio-from-asset.md) covers batch transcription without the live turn-taking loop.
- [`generate-video-from-adf.md`](/Users/famao/kyberion/knowledge/public/procedures/media/generate-video-from-adf.md) covers prompt-based video generation.
