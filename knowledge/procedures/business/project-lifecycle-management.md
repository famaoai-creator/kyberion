# Procedure: Project Lifecycle Management (Talent & Sunset)

## 1. Goal
Manage the human and temporal boundaries of a project, from defining talent requirements to executing decommissioning (Sunset).

## 2. Dependencies
- **Actuator**: `File-Actuator`
- **Actuator**: `Media-Actuator`

## 3. Step-by-Step Instructions
1.  **Talent Generation**:
    - Analyze the technical stack using `map-dependencies.md`.
    - Generate a "Talent Spec" Markdown file using `File-Actuator` and `generate-from-template.md`.
2.  **Sunset Execution**:
    - Identify all project assets using `map-codebase.md`.
    - Archive assets into the `vault/` using `organize-assets.md`.
    - Generate a final `mission-closure-report.md` using `Media-Actuator`.
    - Decommission active mission states using `File-Actuator` (delete).

## 4. Expected Output
Clearly defined personnel needs or a cleanly decommissioned project state with evidence.
