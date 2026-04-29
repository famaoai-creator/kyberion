# Procedure: Realtime Voice Conversation

## Goal

Run a turn-based realtime voice conversation using:

- an `active` voice profile
- a configured speech-to-text bridge
- a configured reasoning backend
- governed voice generation for the assistant reply

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

## Result

The command writes:

- session transcript:
  - `active/shared/runtime/realtime-voice-conversations/<session_id>.json`
- optional reply artifact:
  - `active/shared/tmp/realtime-voice-conversation/<request_id>.wav`

Returned payload includes:

- transcribed user text
- assistant reply text
- voice generation result
- presence timelines for ingress and reply

## Important Constraint

This runtime enables governed turn-based live conversation.
It does not itself train or promote a voice profile.

If the user says `use my voice`, registration and promotion still have to happen first via:

- [register-voice-profile.md](./register-voice-profile.md)
- [promote-voice-profile.md](./promote-voice-profile.md)
