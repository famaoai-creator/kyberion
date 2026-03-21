# Procedure: Visual Asset Generation & Rendering

## 1. Goal
Generate visual artifacts such as diagrams, PDF documents, and visual evidence GIFs from structured data or Markdown.

## 2. Dependencies
- **Actuator**: `Media-Actuator`

## 3. Step-by-Step Instructions
1.  **Diagramming**: Define Mermaid or D2 code and use `Media-Actuator` pipeline ops to render it.
    ```json
    {
      "action": "pipeline",
      "steps": [
        {
          "type": "apply",
          "op": "mermaid_render",
          "params": {
            "input_path": "diagram.mmd",
            "path": "diagram.svg"
          }
        }
      ]
    }
    ```
2.  **PDF Publishing**: Prepare Markdown content and convert it to PDF via `Media-Actuator`.
3.  **Evidence Capturing**: Collect image frames and use `Media-Actuator` with the `gif` action to create an animated sequence.

## 4. Expected Output
High-fidelity visual assets (SVG, PNG, PDF, GIF) suitable for reporting and auditing.
