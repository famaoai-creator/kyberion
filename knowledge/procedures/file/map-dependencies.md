# Procedure: Dependency Mapping

## 1. Goal
Extract and visualize dependencies between source files by identifying import/require statements.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Identify the target directory (default: `src`).
2.  Use `File-Actuator` search with the following dependency patterns:
    
    | Technology | Regex Pattern |
    | :--- | :--- |
    | **ESM/TS** | `import .* from ['\"].*['\"]` |
    | **CommonJS** | `require\(['\"].*['\"]\)` |
    | **Python** | `import .*\|from .* import .*` |

3.  Execute search:
    ```json
    {
      "action": "search",
      "path": ".",
      "pattern": "import .* from|require\\("
    }
    ```
4.  Consolidate matching file-to-module mappings.
5.  Generate a Mermaid `graph TD` based on the extracted mappings.

## 4. Expected Output
A Mermaid dependency graph or a JSON mapping of module connections.
