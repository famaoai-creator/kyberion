# Procedure: Sensitivity & PII Detection

## 1. Goal
Scan the workspace for sensitive information, such as API keys, passwords, and Personal Identifiable Information (PII).

## 2. Dependencies
- **Actuator**: `File-Actuator` (Text Search)
- **Actuator**: `Media-Actuator` (Binary Extraction)

## 3. Step-by-Step Instructions
1.  **Identify Targets**: Identify the target `path` (default: `.`).
2.  **Text Search**: Execute `File-Actuator` search for credentials and PII in source files.
3.  **Binary Extraction**: For PDF, DOCX, and XLSX files, use `Media-Actuator` with the `extract` action to retrieve text content.
    ```json
    {
      "action": "extract",
      "file_path": "path/to/document.pdf",
      "mode": "content"
    }
    ```
4.  **Cross-Check**: Apply sensitivity patterns to the extracted text from binary files.
5.  **Surface Findings**: Map potential sensitive data locations within the codebase and assets.


## 4. Expected Output
A list of potential sensitive data locations within the codebase.
