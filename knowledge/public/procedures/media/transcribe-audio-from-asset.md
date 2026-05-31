# Procedure: Transcribe Audio From Asset

## 1. Goal
Turn a governed audio asset into a text transcript using the speech-to-text bridge.

This is the procedure behind the `transcribe-audio` intent and its default execution profile:

- intent: `transcribe-audio`
- execution profile: `audio-transcribe-default`
- capability bundle: `audio-transcription-governed`

## 2. Dependencies
- **Actuator**: `wisdom-actuator`
- **Artifact path**: a governed audio file or locally staged audio asset
- **Bridge**: a configured speech-to-text bridge or transcript sidecar path

## 3. Input Shape
The input should identify the audio source and optionally the target transcript path.

- `audio_path`: path to the input audio file
- `language`: optional language hint
- `output_path`: optional transcript output path

The procedure does not require a live conversation session. It is a batch transcription path.

## 4. Execution
Use the governed STT op:

```bash
pnpm wisdom:transcribe-audio \
  --audio-path active/shared/tmp/example.wav \
  --language ja
```

If a transcript sidecar already exists, the bridge may reuse it instead of invoking a real decoder.

## 5. Expected Output
- transcript text
- STT backend metadata
- optional transcript artifact path
- execution receipt for auditability

## 6. Design Rule
Keep this procedure focused on batch transcription only.
Live turn-taking belongs to the realtime voice conversation procedure, not here.

