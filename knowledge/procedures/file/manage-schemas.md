# Procedure: Schema Inspection & Validation

## 1. Goal
Inspect the structure of JSON/YAML schemas and validate data files against them to ensure structural integrity.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  **Inspection**:
    - Use `File-Actuator` with the `read` action to load the schema file (`.json`, `.yaml`, `.schema.json`).
    - Extract top-level keys and types using the agent's internal logic.
2.  **Validation**:
    - Load the target data file using `File-Actuator`.
    - Compare the data structure against the loaded schema definition.
3.  **ADF Usage**:
    ```json
    {
      "action": "read",
      "path": "schemas/mission-contract.schema.json"
    }
    ```

## 4. Expected Output
A detailed report of schema compliance or a map of the schema's required fields and types.
