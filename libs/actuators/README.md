# Kyberion Actuators (The Physical Seven)

## 1. Overview
Actuators are the generic, high-fidelity execution engines of the Kyberion ecosystem. They serve as the physical interface between the agent's logic (Procedures) and reality (Filesystem, Network, OS).

## 2. Design Principles
- **Agnostic Logic**: Actuators do not know *what* they are doing or *why*. They only know *how* to execute a specific class of physical actions.
- **ADF-Native**: Every Actuator takes a structured JSON input (ADF - Agentic Data Format) and returns a structured JSON output.
- **Secure-IO Enforced**: All Actuators must use `@agent/core/secure-io` for all physical operations.
- **High Fidelity**: Actuators provide rich metadata and evidence (hashes, screenshots, logs) for every action.

## 3. The Seven Actuators
1. **Code-Actuator**: Logic analysis, refactoring, building, and testing.
2. **File-Actuator**: File I/O, advanced search (ripgrep), and metadata discovery.
3. **Network-Actuator**: Secure API communications and data scrubbing.
4. **Wisdom-Actuator**: Knowledge distillation, memory management, and identity swapping.
5. **Media-Actuator**: Diagram rendering, document conversion, and visual asset generation.
6. **Browser-Actuator**: Web automation via Playwright and recording distillation.
7. **System-Actuator**: Physical peripherals (Keyboard/Mouse), voice synthesis, and OS state.

## 4. Implementation Status
- [x] Code-Actuator
- [x] File-Actuator
- [x] Network-Actuator
- [x] Wisdom-Actuator
- [x] Media-Actuator
- [x] Browser-Actuator
- [x] System-Actuator
