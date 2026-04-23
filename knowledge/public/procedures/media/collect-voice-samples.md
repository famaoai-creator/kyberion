# Procedure: Collect Voice Samples

## Goal

Copy operator-provided voice files into a governed staging area before profile registration.

This procedure does not register or promote a profile by itself.
It prepares:

- staged sample files
- a collection manifest
- a registration candidate payload

## Optional Recording Step

If you want Kyberion to invoke a local recorder command, use:

- `record_voice_sample`

This action requires `KYBERION_AUDIO_RECORD_COMMAND`.

Supported placeholder variables in that command:

- `{{output}}`
- `{{duration_sec}}`
- `{{language}}`
- `{{prompt_path}}`
- `{{sample_id}}`
- `{{request_id}}`

Example:

```bash
export KYBERION_AUDIO_RECORD_COMMAND='ffmpeg -y -f avfoundation -i :0 -t {{duration_sec}} {{output}}'
```

Or with a prompt file:

```bash
export KYBERION_AUDIO_RECORD_COMMAND='my-recorder --out {{output}} --seconds {{duration_sec}} --prompt-file {{prompt_path}}'
```

## Contract

Use `collect_voice_samples` with:

- `request_id`
- `samples`
  - `sample_id`
  - `path`
  - optional `language`
- optional `profile_draft`

## Example

```json
{
  "action": "collect_voice_samples",
  "request_id": "collect-user-ja-001",
  "profile_draft": {
    "profile_id": "user-ja-voice",
    "display_name": "User Japanese Voice",
    "tier": "personal",
    "languages": ["ja"],
    "default_engine_id": "open_voice_clone"
  },
  "samples": [
    { "sample_id": "s1", "path": "Downloads/voice-01.wav", "language": "ja" },
    { "sample_id": "s2", "path": "Downloads/voice-02.wav", "language": "ja" },
    { "sample_id": "s3", "path": "Downloads/voice-03.wav", "language": "ja" }
  ]
}
```

## Output

Successful collection writes:

- collection directory:
  - `active/shared/tmp/voice-sample-collection/<request_id>/`
- collection manifest:
  - `active/shared/tmp/voice-sample-collection/<request_id>/collection-manifest.json`

The result also includes `registration_candidate`, which can be passed directly into `register_voice_profile`.

## Flow

1. collect files into staging
2. register profile with staged paths
3. promote approved profile
4. use it in realtime voice conversation

## Combined Shortcut

If you want collection and registration in one request, use:

- `collect_and_register_voice_profile`

This runs:

1. `collect_voice_samples`
2. `register_voice_profile`

and returns both results in one payload.
