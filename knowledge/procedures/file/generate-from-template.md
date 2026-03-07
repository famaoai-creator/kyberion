# Procedure: Generate Files from Templates

## 1. Goal
Create new files based on predefined templates and dynamic variable injection.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Identify the template path (e.g., `templates/skill-template-ts/index.ts`).
2.  Use `File-Actuator` with the `read` action to load the template content.
3.  Inject variables (e.g., `{{name}}`, `{{description}}`) using the agent's internal string replacement logic.
4.  Define the target output path.
5.  Use `File-Actuator` with the `write` action to create the new file.
    ```json
    {
      "action": "write",
      "path": "skills/new-skill/index.ts",
      "content": "FINAL_CONTENT_HERE"
    }
    ```

## 4. Expected Output
A new file generated with all template variables correctly resolved.
