# Procedure: Security & Compliance Scanning

## 1. Goal
Identify security vulnerabilities, leaked credentials, and compliance violations within the codebase and infrastructure definitions.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  **Credential Leak Scan**: Use `File-Actuator` with `detect-sensitivity.md` to find API keys or secrets.
2.  **Vulnerability Pattern Scan**: Search for dangerous functions using `File-Actuator`:
    
    | Vulnerability | Regex Pattern |
    | :--- | :--- |
    | **Command Injection** | `exec\(.*[\$|+]\|spawn\(.*[\$|+]` |
    | **Dangerous Eval** | `eval\(\|new Function\(` |
    | **Hardcoded Paths** | `\/Users\/[a-zA-Z0-9._-]+\/` |

3.  **Compliance Check**: Verify presence of mandatory security files (`.gitignore`, `vault/secrets/`).
4.  **Reporting**: Aggregate findings into an Issue list (ADF).

## 4. Expected Output
A prioritized list of security findings and compliance gaps.
