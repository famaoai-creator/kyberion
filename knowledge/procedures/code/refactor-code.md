# Procedure: Targeted Code Refactoring

## 1. Goal
Apply surgical modifications to source code files while maintaining structural integrity and passing build checks.

## 2. Dependencies
- **Actuator**: `Code-Actuator`

## 3. Step-by-Step Instructions
1.  **Analysis**: Use `Code-Actuator` with `analyze` to understand existing exports and structure.
2.  **Drafting**: Define the `old` and `new` string pairs for the target modification.
3.  **Execution**: Use `Code-Actuator` with the `refactor` action.
    ```json
    {
      "action": "refactor",
      "path": "src/module.ts",
      "changes": [
        { "old": "function legacy()", "new": "function modern()" }
      ]
    }
    ```
4.  **Verification**: Use `Code-Actuator` with `verify` (npm run build) to ensure no regressions were introduced.

## 4. Expected Output
A successfully modified file that passes all build and linting gates.
