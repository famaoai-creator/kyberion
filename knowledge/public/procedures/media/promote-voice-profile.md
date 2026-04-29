# Procedure: Promote Voice Profile

## Goal

Promote a validated voice-profile registration receipt into the active voice profile registry.

This is the step that makes a registered profile usable for:

- narrated artifact generation
- strict personal-voice routing
- realtime voice conversation

## Input

- registration receipt produced by:
  - [register-voice-profile.md](./register-voice-profile.md)
- explicit approver identity

## CLI

```bash
pnpm voice:profile:promote \
  --receipt active/shared/tmp/voice-profile-registration/reg-user-ja-001.json \
  --approved-by operator \
  --target-status active \
  --set-default
```

## Result

The command:

- appends the promoted profile to the voice profile registry
- optionally updates `default_profile_id`
- writes a promotion receipt under:
  - `active/shared/tmp/voice-profile-promotion/<request_id>.json`

Tier routing:

- `personal` profiles are written to `knowledge/personal/voice/profile-registry.json` by default
- `confidential` and `public` profiles continue to use `knowledge/public/governance/voice-profile-registry.json`
- `KYBERION_VOICE_PROFILE_REGISTRY_PATH` still overrides the target registry explicitly

## Important Constraint

Realtime use still requires:

- an `active` profile
- a clone-capable engine if strict personal voice mode is used
- a working STT backend for live input
