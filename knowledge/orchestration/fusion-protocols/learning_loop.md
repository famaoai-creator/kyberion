# Continuous Learning Loop Protocol

This protocol defines how the ecosystem evolves when new external knowledge is harvested.

## 1. Trigger Event

When `knowledge-harvester` adds new files to `knowledge/external-wisdom/`:

1.  **Analyze**: `auto-context-mapper` scans the new content for keywords (e.g., "security", "architecture", "testing").
2.  **Notify**: The system flags related skills as "Update Recommended."

## 2. Refinement Action

- If **"Security"** wisdom found -> Update `security-scanner` instructions and `persona-matrix`.
- If **"Coding Style"** wisdom found -> Update `boilerplate-genie` templates.
- If **"Process"** wisdom found -> Update `mission-control` intent mappings.

## 3. Autonomous Execution

The `skill-evolution-engine` is responsible for applying these updates via Pull Request, ensuring the agent's behavior permanently improves based on external data.
