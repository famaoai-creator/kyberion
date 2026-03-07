# Procedure: Executive Reporting & Communication

## 1. Goal
Generate high-fidelity, board-ready reports and communicate project status to key stakeholders with appropriate tone and granularity.

## 2. Dependencies
- **Actuator**: `Media-Actuator` (Document Generation)
- **Actuator**: `Network-Actuator` (Distribution)

## 3. Step-by-Step Instructions
1.  **Data Aggregation**: Collect raw evidence from `evidence/` using `File-Actuator`.
2.  **Report Drafting**: Use `Media-Actuator` with the `convert` or `assemble` action.
    - Select Template: `knowledge/templates/reporting/audience_strategy.md`.
    - Apply Design Protocol: Use `Kyberion-Standard` PPT/Excel styles.
3.  **Refinement**: Review the report granularity using `knowledge/orchestration/context-extraction-rules.md`.
4.  **Distribution**: Use `Network-Actuator` to send the finalized report via Slack or Email.

## 4. Expected Output
A professional reporting artifact (PDF/PPTX) delivered to the target audience.
