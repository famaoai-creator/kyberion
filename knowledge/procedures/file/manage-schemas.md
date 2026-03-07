# Procedure: Schema Inspection & Validation

## 1. Goal
Inspect the structure of JSON/YAML schemas and validate data files against them to ensure structural integrity.

## 2. Dependencies
- **Actuator**: `File-Actuator` (Inspection)
- **Actuator**: `Modeling-Actuator` (Deterministic Validation)

## 3. Step-by-Step Instructions
1.  **Inspection**:
    - Use `File-Actuator` with the `read` action to load the schema file.
2.  **Validation**:
    - Execute `Modeling-Actuator` with the `validate` action to ensure data strictly adheres to the JSON Schema using `ajv`.
    ```json
    {
      "action": "validate",
      "schemaPath": "schemas/mission-contract.schema.json",
      "dataPath": "active/missions/MSN-ID/contract.json"
    }
    ```
3.  **Correction**:
    - If validation fails, use the error output from `ajv` to surgically fix the data file using `File-Actuator`.

## 4. Expected Output
A detailed report of schema compliance or a map of the schema's required fields and types.
