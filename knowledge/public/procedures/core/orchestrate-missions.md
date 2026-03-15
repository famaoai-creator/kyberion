# Procedure: Mission Orchestration & Self-Healing

## 1. Goal
Execute complex multi-step missions based on JSON ADF pipelines and automatically recover from technical failures.

## 2. Dependencies
- **Actuator**: `Orchestrator-Actuator`
- **Actuator**: `Code-Actuator` (for physical repairs)

## 3. Step-by-Step Instructions
1.  **Preparation**: Define the mission objective and select the appropriate pipeline (`pipelines/*.json`).
2.  **Execution**: Run the built pipeline runner against the selected ADF.
    ```json
    node dist/scripts/run_pipeline.js --input pipelines/vital-check.json
    ```
3.  **Failure Detection**: If a step fails, inspect the returned step results and the pipeline runner exit code.
4.  **Auto-Healing**:
    - Use `Orchestrator-Actuator` or `Code-Actuator` with a follow-up JSON ADF to diagnose the error.
    - Execute the proposed patch using `Code-Actuator` (refactor).
5.  **Checkpointing**: Use `Orchestrator-Actuator` with `checkpoint` after each successful repair.

## 4. Expected Output
A successfully completed mission with a hash-verified audit trail of all actions and repairs.
