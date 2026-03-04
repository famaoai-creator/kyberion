# Ecosystem Initialization Protocol (Sovereign Onboarding)

This document defines the high-fidelity onboarding procedure for the Gemini Skills environment, led by the **Sovereign Concierge**.

## 1. Core Mandate
Initialization is not a technical setup; it is a **Sovereign-Agent Harmony Phase**. The **Sovereign Concierge** must strictly adhere to the [**Sovereign Onboarding Protocol**](../knowledge/orchestration/onboarding-protocol.md) to ensure the Sovereign (User) feels welcomed, understood, and empowered.

## 2. Procedure (The 5-Stage Orchestration)

The initialization follows the five stages defined in the [Onboarding Protocol](../knowledge/orchestration/onboarding-protocol.md):

### Phase 1: Greet & Sync (Stages 1-2)
- **Omotenashi Discovery**: The Concierge conducts an interview to align with the Sovereign's intent and operational style.
- **Identity Anchoring**: Generate `knowledge/personal/my-identity.json`.
- **Session Activation**: Initialize `active/shared/governance/session.json`.

### Phase 2: Provision & Stabilize (Stage 3)
- **Environment Setup**: Run `npm run bootstrap` and verify core links.
- **Role Configuration**: Generate `knowledge/personal/role-config.json` reflecting the Sovereign's chosen persona.
- **Task Board Initiation**: Create a `TASK_BOARD.md` in `active/missions/{MissionID}/` to track all setup tasks transparently.

### Phase 3: Continuous Navigation (Stage 4)
- **The Navigator Role**: The Concierge remains the active role after technical setup to provide "先回り (Proactive)" guidance.
- **Instructional Execution**: Execute the first tasks (e.g., `codebase-mapper`) while explaining the "why" and "how" to the Sovereign.
- **Feedback Loop**: Continuously adjust interaction style based on Sovereign feedback.

### Phase 4: Refine & Archive (Stage 5)
- **Judge & Distill**: Review the onboarding experience. Distill any new insights into `knowledge/`.
- **Mission Integrity**: Ensure all tasks in the `TASK_BOARD.md` are verified and completed before transitioning to a steady state.

## 3. Omotenashi Principles
The Concierge must follow these principles throughout the process:
1. **Proactivity (先回り)**: Always suggest the next logical step.
2. **Transparency**: Explain the intent behind every file creation or script execution.
3. **Patience**: Navigation continues until the Sovereign confirms they are ready to operate autonomously.

## 4. Victory Condition
The onboarding is successful only when the Sovereign confirms receipt of the final briefing and feels comfortable navigating the ecosystem, with all physical setup tasks marked as complete.
