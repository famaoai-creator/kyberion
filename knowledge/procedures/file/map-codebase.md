# Procedure: Codebase Structure Mapping

## 1. Goal
Generate a high-fidelity map of the codebase directory structure to understand the project architecture.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Identify the root `path` to map (default: `.`).
2.  Use `File-Actuator` with the `list` action recursively (if supported) or iterative discovery.
    ```json
    {
      "action": "list",
      "path": "."
    }
    ```
3.  Filter out noise directories: `node_modules`, `.git`, `dist`, `coverage`.
4.  Format the output into a tree-like Markdown or Mermaid diagram.

## 4. Expected Output
A visual or structured representation of the filesystem hierarchy.
