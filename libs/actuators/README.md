# Kyberion Actuators (The Physical Engines)

## 1. Overview
Actuators are the generic, high-fidelity execution engines of the Kyberion ecosystem. They serve as the physical interface between the agent's logic (Procedures) and reality (Filesystem, Network, OS, Blockchain).

## 2. Design Principles
- **Agnostic Logic**: Actuators only know *how* to execute a specific class of physical actions based on ADF (Agentic Data Format).
- **Capability Manifest**: Each Actuator self-declares its supported operations, platforms, and binary requirements via `manifest.json`.
- **High Fidelity**: Provides immutable evidence (hashes, signatures) for every action taken.

## 3. The Actuators (Core Nine)
1. **Code-Actuator**: Logic analysis, refactoring, and testing.
2. **File-Actuator**: Advanced file I/O and discovery.
3. **Network-Actuator**: Secure API communications.
4. **Wisdom-Actuator**: Knowledge distillation and identity management.
5. **Media-Actuator**: Document conversion and visual asset generation.
6. **Browser-Actuator**: Web automation and recording.
7. **System-Actuator**: Keyboard/Mouse, Voice, and OS-level operations.
8. **Secret-Actuator**: **[NEW]** Native bridge to OS Secret Managers (macOS Keychain, etc.).
9. **Blockchain-Actuator**: **[NEW]** Immutable anchoring of mission evidence and trust scores.

## 4. Implementation Status & Capabilities
Use the following command to check the actual status in your current environment:
```bash
pnpm capabilities
```

---
*Last Updated: 2026-03-11*
