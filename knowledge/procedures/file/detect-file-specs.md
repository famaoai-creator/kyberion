# Procedure: Detect File Specifications (Format, Encoding, Language)

## 1. Goal
Determine the physical and logical characteristics of a file, such as its format (MIME), encoding (UTF-8, etc.), and programming language.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Use `File-Actuator` with the `stat` action to get file size and basic metadata.
    ```json
    {
      "action": "stat",
      "path": "path/to/file"
    }
    ```
2.  If the format is unknown, use `File-Actuator` with `read` to extract the first 1024 bytes (Head).
3.  Analyze the extension and content:
    - **Language**: Pattern match keywords (e.g., `import`, `function`, `class` for TS).
    - **Encoding**: Check for BOM or common byte sequences.
4.  Consolidate the findings into a single characteristic report.

## 4. Expected Output
A JSON summary of the file's technical specifications.
