---
title: Triple-Tier Persona Model: Identity, Mask, and Mission
category: Tech-stack
tags: [tech-stack, persona, model]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Triple-Tier Persona Model: Identity, Mask, and Mission

The Kyberion Ecosystem employs a **Triple-Tier Persona Model** to manage user identity and agent roles. This architecture separates the user's permanent self ("Soul") from the transient roles required for specific tasks ("Masks").

## 1. Architectural Layers

| Tier | File Path | Philosophy | Role |
| :--- | :--- | :--- | :--- |
| **Soul (Identity)** | `knowledge/personal/my-identity.json` | **Immutable Soul** | Permanent user preferences (Name, Language, Style). Shared across all roles. |
| **Mask (Session)** | `active/shared/governance/session.json` | **Global Mask** | The current default role for the CLI session (e.g., Ecosystem Architect). |
| **Mission (Local)** | `active/missions/{ID}/role-state.json` | **Task Mask** | Temporary role scoped to a specific mission. Enables parallel execution. |

## 2. Parallel Role Resolution (The Priority Rule)

When a skill or script asks "Who am I?", the system resolves the identity in the following order:

1.  **Mission-Scoped**: If `process.env.MISSION_ID` is set, look for `role-state.json` in the mission folder.
2.  **Shared Session**: If no mission is active, look for `session.json` in the governance folder.
3.  **Personal Legacy**: Fallback to `role-config.json` for backward compatibility.

## 3. Benefits of the Model

-   **Parallel Execution**: Different agents (e.g., an Engineer and an Auditor) can work on different missions simultaneously without context collisions.
-   **Enhanced Privacy**: Separates private user data (Soul) from public or shared mission data (Masks).
-   **Audit Integrity**: Each mission log contains exactly which role was active during its execution.
-   **Security**: Prevents unauthorized tier access by scoping role permissions to the active mission's tier.

## 4. Usage Guidelines

### Customizing Your Soul
Edit `knowledge/personal/my-identity.json` to set your name and interaction style. This information is available to all roles to personalize responses.

### Switching Global Masks
Use the `init_wizard.js` or manually update `active/shared/governance/session.json`.

### Assigning Mission Masks
When starting a mission, create a `role-state.json` within the mission directory to override the global session role.
