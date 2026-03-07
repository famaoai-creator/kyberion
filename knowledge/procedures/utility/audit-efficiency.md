# Procedure: Token Economics & Completeness Scoring

## 1. Goal
Monitor token consumption efficiency and evaluate the completeness of generated artifacts against mission objectives.

## 2. Dependencies
- **Actuator**: `Wisdom-Actuator` (Mirror/Audit)
- **Actuator**: `Modeling-Actuator` (Scoring)

## 3. Step-by-Step Instructions
1.  **Token Audit**: Use `Wisdom-Actuator` to scan `evidence/cost-report.json` for high-volume sessions.
2.  **Efficiency Scoring**: 
    - Input token data into `Modeling-Actuator` to calculate ROI (Useful Output / Token Cost).
3.  **Completeness Check**: 
    - Compare generated files against `MissionContract` victory conditions using `File-Actuator`.
    - Score completeness (0-100%) using `score-quality.md` logic.
4.  **Optimization**: Propose `Prompt-Optimizer` triggers if efficiency falls below 0.6.

## 4. Expected Output
An efficiency report and a verification of mission completeness.
