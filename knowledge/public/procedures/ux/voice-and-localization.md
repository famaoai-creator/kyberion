---
title: 'Procedure: Voice Interface & Localization'
last_updated: 2026-10-05
---

# Procedure: Voice Interface & Localization

## 1. Goal

Manage voice-based interactions, synthesize speech, and localize content across multiple languages.

## 2. Dependencies

- **Actuator**: `voice-actuator` (Speech Synthesis: `speak_local`, `generate_voice`, `list_voices`)
- **CLI**: `pnpm kyberion speak` (equivalent local playback / audio-file rendering surface)
- **Actuator**: `wisdom-actuator` (Translation/Localization reasoning)

## 3. Step-by-Step Instructions

1.  **Voice Synthesis**:
    - Prepare the text payload.
    - For immediate local playback, use `voice-actuator` with `speak_local`:
    ```json
    {
      "action": "speak_local",
      "params": { "text": "Localization complete.", "language": "en" }
    }
    ```
    - Optional `speak_local` params: `voice`, `rate`, `engine_id`, `purpose`, `local_only` (see `libs/actuators/voice-actuator/src/op-catalog.ts`). Run `list_voices` first to enumerate available voices.
    - CLI equivalent: `pnpm kyberion speak "Localization complete." --lang en` — add `--out <audio-file>` to render an artifact instead of playing, or `--stream --segment <text>` for incremental output.
    - For governed artifact generation (voice profile, engine selection, chunked rendering, delivery mode), use the `generate_voice` ADF contract (`knowledge/product/schemas/voice-generation-adf.schema.json`).
2.  **Localization**:
    - Use `file-actuator` to read language resource files (e.g., `.json`, `.yml`).
    - Translate and culturally adapt content using the agent's internal logic.
    - Write the localized files back to the project.
    - To speak localized feedback, pass the target language to `speak_local` (`params.language`, BCP-47) or `pnpm kyberion speak --lang <bcp47>`.

## 4. Expected Output

Audible feedback and synchronized multi-language resource files.
