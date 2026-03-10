# Procedure: Search Pattern in Filesystem

## 1. Goal
Search for a specific regular expression pattern within file contents across the workspace.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Define the `pattern` to search for (e.g., `\bTODO\b`).
2.  Identify the `path` to start the search from (default: `.`).
3.  Prepare the ADF input JSON for `File-Actuator`:
    ```json
    {
      "action": "search",
      "path": ".",
      "pattern": "YOUR_PATTERN_HERE"
    }
  ```
4.  Execute the `File-Actuator` with the prepared input.
5.  Parse the JSON output to identify matching files and line numbers.

## 4. Expected Output (ADF)
A JSON object containing a `results` array of matching lines.
