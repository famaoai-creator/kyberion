# Procedure: Sensitivity & PII Detection

## 1. Goal
Scan the workspace for sensitive information, such as API keys, passwords, and Personal Identifiable Information (PII).

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Identify the target `path` (default: `.`).
2.  Define the sensitivity patterns to scan for:
    
    | Category | Regex Pattern |
    | :--- | :--- |
    | **Credentials** | `api[_-]?key\|secret\|password\|token\|bearer` |
    | **PII** | `email\|address\|phone\|social_security` |
    | **Internal Paths** | `\/Users\/[a-zA-Z0-9._-]+\/` |

3.  Execute `File-Actuator` search for each pattern:
    ```json
    {
      "action": "search",
      "path": ".",
      "pattern": "api[_-]?key|secret|password|token"
    }
    ```
4.  Surface matching lines for immediate scrubbing or auditing.

## 4. Expected Output
A list of potential sensitive data locations within the codebase.
