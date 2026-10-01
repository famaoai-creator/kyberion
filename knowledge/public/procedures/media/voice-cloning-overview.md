# Procedure: Voice Cloning Overview

## Goal

Give the operator a single entry point for the cloned-voice flow.

## The 4 Steps

1. **Collect**
   - Stage raw samples under `active/shared/tmp/voice-sample-collection/<request_id>/`
   - Procedure: [collect-voice-samples.md](collect-voice-samples.md)

2. **Register**
   - Validate the sample set and write a registration receipt
   - Procedure: [register-voice-profile.md](register-voice-profile.md)

3. **Promote**
   - Approve the receipt and move the profile into the active registry
   - The runtime voice files live under `active/shared/runtime/voice-profiles/<profile_id>/`
   - Procedure: [promote-voice-profile.md](promote-voice-profile.md)

4. **Speak**
   - Use the promoted runtime profile for narration or live conversation
   - Procedures:
     - [speak-with-my-voice.json](../../../product/pipeline-templates/speak-with-my-voice.json)
     - [realtime-voice-conversation.md](realtime-voice-conversation.md)

## Where Data Lives

- Temporary staging: `active/shared/tmp/`
- Promoted voice profile data: `active/shared/runtime/voice-profiles/<profile_id>/`
- Registry snapshot: `knowledge/product/governance/voice-profile-registry.json`
- Canonical per-profile files: `knowledge/product/governance/voice-profiles/*.json`

## Rule of Thumb

- If you are still recording, you are in `tmp`.
- If the profile is ready for `pnpm pipeline speak-with-my-voice` or `live-voice`, it should already be in the runtime voice-profile store.
