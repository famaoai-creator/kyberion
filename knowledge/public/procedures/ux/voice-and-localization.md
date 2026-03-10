# Procedure: Voice Interface & Localization

## 1. Goal
Manage voice-based interactions, synthesize speech, and localize content across multiple languages.

## 2. Dependencies
- **Actuator**: `System-Actuator` (Voice Synthesis)
- **Actuator**: `Wisdom-Actuator` (Translation/Localization)

## 3. Step-by-Step Instructions
1.  **Voice Synthesis**:
    - Prepare the text payload.
    - Use `System-Actuator` with the `voice` action to generate speech output on the host machine.
    ```json
    {
      "action": "voice",
      "voice": { "text": "Localization complete." }
    }
    ```
2.  **Localization**:
    - Use `File-Actuator` to read language resource files (e.g., `.json`, `.yml`).
    - Translate and culturally adapt content using the agent's internal logic.
    - Write the localized files back to the project.

## 4. Expected Output
Audible feedback and synchronized multi-language resource files.
