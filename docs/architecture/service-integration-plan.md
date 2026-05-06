# Service-Centric Infrastructure Integration Plan

## 1. Objective
Transition machine-dependent tool configurations (hardcoded paths, local bin references) into Kyberion's formal **Service/Connection Framework**. This ensures environment independence, portability, and unified governance.

## 2. Target Services
| Service | Capability | Primary Driver | Context |
|---|---|---|---|
| **ComfyUI** | Media Gen (Image/Music/Video) | API / CLI | [Completed] Integrated via `comfyui.json` |
| **Whisper** | STT (Speech-to-Text) | `whisper.cpp` / `WhisperKit` | Local binary and model paths |
| **Voice-TTS** | TTS (Text-to-Speech) | `say` (macOS) / `Style-Bert-VITS2` | Voice profiles and engine configs |
| **Meeting** | Collaboration | Zoom / Teams / Meet | App URIs and browser driver paths |

## 3. Integration Architecture
For each service, we implement:
1.  **Connection Metadata** (`knowledge/personal/connections/{service}.json`): Stores machine-specific paths, URLs, and secrets.
2.  **Service Preset** (`knowledge/public/orchestration/service-presets/{service}.json`): Defines standardized operations (CLI/API) using placeholders.
3.  **Dynamic Resolvers**: Kyberion's `Service Engine` resolves placeholders at runtime using the connection metadata.

## 4. Implementation Roadmap

### Phase 1: Local AI Infrastructure (Current)
- [x] ComfyUI: Connection + Presets + Fragments.
- [~] Whisper (STT): Preset files added for `transcribe` and `stream`; runtime validation pending.
- [~] Voice (TTS): Native and generative paths mapped in presets; runtime validation pending.

### Phase 2: Communication & Collaboration
- [~] Zoom/Teams: Meeting preset scaffolding added (`join`, `status`, `leave`); integration validation pending.
- [ ] Meeting-Browser-Driver: Dynamic path resolution for Playwright/Chromium.

### Phase 3: Validation & Automation
- [ ] Update `baseline-check` to verify connections are satisfied.
- [ ] Create automated "Self-Healing" prompts for missing connections.

## 5. Governance and Security
- All connection files remain in `knowledge/personal/` (Tier-1 Private).
- Access to these services is gated by `secret-guard` and `grantAccess` per mission.
