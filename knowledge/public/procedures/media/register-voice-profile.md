# Procedure: Register Voice Profile

## 1. Goal

Validate and register a personal or confidential voice profile request as a governed promotion candidate.

This procedure validates samples and writes a registration receipt.
It does not auto-promote the profile to active runtime usage.

## 2. Dependencies

- **Actuator**: `voice-actuator`
- **Schemas**:
  - [`voice-sample-collection.schema.json`](../../schemas/voice-sample-collection.schema.json)
  - [`voice-profile-registration.schema.json`](../../schemas/voice-profile-registration.schema.json)
  - [`voice-sample-ingestion-policy.schema.json`](../../schemas/voice-sample-ingestion-policy.schema.json)
- **Governance**:
  - [`voice-sample-ingestion-policy.json`](../../governance/voice-sample-ingestion-policy.json)

## 3. Contract Shape

`register_voice_profile` requires:

- `request_id`
- `profile` (`profile_id`, `display_name`, `tier`, `languages`, `default_engine_id`)
- `samples` (`sample_id`, `path`, optional `language`)

Optional:

- `policy.strict_personal_voice` to override strict fallback behavior for this request.

## 4. Execution

If raw files have not been staged yet, collect them first:

- [collect-voice-samples.md](./collect-voice-samples.md)

Or use the combined shortcut:

- `collect_and_register_voice_profile`

Example action:

```json
{
  "action": "register_voice_profile",
  "request_id": "reg-user-ja-001",
  "profile": {
    "profile_id": "user-ja-voice",
    "display_name": "User Japanese Voice",
    "tier": "personal",
    "languages": ["ja"],
    "default_engine_id": "open_voice_clone"
  },
  "samples": [
    { "sample_id": "s1", "path": "active/shared/tmp/voice/user-ja-01.wav", "language": "ja" },
    { "sample_id": "s2", "path": "active/shared/tmp/voice/user-ja-02.wav", "language": "ja" },
    { "sample_id": "s3", "path": "active/shared/tmp/voice/user-ja-03.wav", "language": "ja" }
  ]
}
```

Run the actuator directly:

```bash
node dist/libs/actuators/voice-actuator/src/index.js --input /path/to/register-voice-profile.json
```

## 5. Expected Output

- `status: succeeded` with `registration_receipt_path` when validation passes
- `status: blocked` with explicit `violations` when validation fails

A successful registration emits a receipt under:

- `active/shared/tmp/voice-profile-registration/<request_id>.json`

## 6. Promotion Rule

Registration validates candidate input only.
Promoting the profile into active governance remains a separate explicit review and approval step.

Promotion procedure:

- [promote-voice-profile.md](./promote-voice-profile.md)
