# Procedure: IP/Patentable Asset Scan

## 1. Goal
Identify potential IP, algorithms, and security protocols within the source code to narrow down areas for patent analysis.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Identify the target directory (default: `.`).
2.  Use `File-Actuator` with the following predefined IP indicators:
    
    | Category | Regex Pattern |
    | :--- | :--- |
    | **Algorithm** | `algorithm\|heuristic\|optimizer\|inference\|model` |
    | **Protocol** | `protocol\|handshake\|negotiation\|bridge` |
    | **Security** | `cipher\|encryption\|decryption\|pqc\|quantum` |

3.  Execute the search for each category:
    ```json
    {
      "action": "search",
      "path": ".",
      "pattern": "algorithm|heuristic|optimizer|inference|model"
    }
    ```
4.  Limit the results to relevant source files (`*.ts`, `*.js`, `*.py`).
5.  Extract the matching snippets for AI-driven high-fidelity analysis.

## 4. Expected Output
A categorized list of source code locations containing potential intellectual property.
