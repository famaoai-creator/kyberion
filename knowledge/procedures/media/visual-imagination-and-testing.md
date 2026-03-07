# Procedure: Visual Imagination & Assertion

## 1. Goal
Generate AI-driven visual concepts and perform visual regression testing using high-fidelity image comparisons.

## 2. Dependencies
- **Actuator**: `Media-Actuator` (Generation/Diff)
- **Actuator**: `Browser-Actuator` (Capturing)

## 3. Step-by-Step Instructions
1.  **Concept Generation**: Use `Media-Actuator` with the `render` action to generate UI mockups or conceptual diagrams from ADF descriptions.
2.  **Visual Capturing**: Use `Browser-Actuator` with `screenshot` to capture the current live state of a web application.
3.  **Assertion**:
    - Compare the live screenshot with the baseline image using `Media-Actuator`.
    - Identify pixel-level deltas and surface them as "Visual Regressions".
4.  **Reporting**: Export the visual diff report via `Media-Actuator`.

## 4. Expected Output
High-fidelity visual mockups or a verified visual assertion report with evidence.
