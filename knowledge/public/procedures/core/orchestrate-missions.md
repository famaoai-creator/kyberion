# Procedure: Mission Orchestration & Self-Healing

## 1. Goal
Execute complex multi-step missions based on YAML pipelines and automatically recover from technical failures.

## 2. Dependencies
- **Actuator**: `Orchestrator-Actuator`
- **Actuator**: `Code-Actuator` (for physical repairs)

## 3. Step-by-Step Instructions
1.  **Preparation**: Define the mission objective and select the appropriate pipeline (`pipelines/*.yml`).
2.  **Execution**: Use `Orchestrator-Actuator` with the `execute` action.
    ```json
    {
      "action": "execute",
      "pipeline_path": "pipelines/core-base-stabilizer.yml",
      "mission_id": "MSN-STABILIZE-001"
    }
    ```
3.  **Failure Detection**: If a step fails, extract the error log from `scratch/last_execution.log`.
4.  **Auto-Healing**:
    - Use `Orchestrator-Actuator` with the `heal` action to diagnose the error.
    - Execute the proposed patch using `Code-Actuator` (refactor).
5.  **Checkpointing**: Use `Orchestrator-Actuator` with `checkpoint` after each successful repair.

## 4. Expected Output
A successfully completed mission with a hash-verified audit trail of all actions and repairs.
