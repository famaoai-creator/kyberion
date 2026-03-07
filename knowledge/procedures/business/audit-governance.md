# Procedure: PMO Governance & Project Health Audit

## 1. Goal
Audit the project directory to ensure compliance with SDLC standards, mandatory documentation, and overall directory hygiene.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  **Hygiene Check**: Use `File-Actuator` with `list` to verify mandatory folders exist: `docs/`, `src/`, `tests/`, `active/missions/`.
2.  **Document Verification**: 
    - Check for `GEMINI.md`, `README.md`, and `package.json` in the root.
    - Check for `mission-state.json` in active mission directories.
3.  **Completeness Scan**: Search for "TODO" or "Pending" keywords in `docs/` using `File-Actuator`.
4.  **Reporting**: Use the gathered metadata to generate a Project Health Score.

## 4. Expected Output
A high-fidelity audit report identifying missing artifacts or governance violations.
