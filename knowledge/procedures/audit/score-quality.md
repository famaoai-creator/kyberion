# Procedure: Quality Scoring & Project Health Assessment

## 1. Goal
Evaluate the quality of code, skills, and overall project health using quantitative scoring models.

## 2. Dependencies
- **Actuator**: `Modeling-Actuator` (Scoring)
- **Actuator**: `File-Actuator` (Data Gathering)

## 3. Step-by-Step Instructions
1.  **Data Collection**:
    - Use `File-Actuator` to gather metrics (file size, lint errors, test coverage).
    - Use `audit-governance.md` to check documentation completeness.
2.  **Scoring**:
    - Input the gathered metrics into `Modeling-Actuator` using the `risk_scoring` model.
    - Weigh factors: Security (40%), Test Coverage (30%), Documentation (20%), Complexity (10%).
3.  **Analysis**: Review the final Health Score (0-100).
4.  **Reporting**: Export the score and breakdown using `Media-Actuator`.

## 4. Expected Output
A high-fidelity project health dashboard and prioritized remediation list.
