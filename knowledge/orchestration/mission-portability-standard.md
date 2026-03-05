# Mission Portability Standard (MEP v0.1)

## 1. Concept
Mission Portability is the ability to package a mission's logic (procedures), governance (contracts), and results (evidence) into a portable format that can be shared across different environments and agents.

## 2. The Mission Export Package (MEP) Structure
A MEP consists of the following core components:
- **Manifest**: Metadata including versioning and skill dependencies.
- **Blueprint**: Procedural logic (`TASK_BOARD.md`) and governance (`contract.json`).
- **Evidence**: Historical execution data (optional, used for anti-pattern sharing or debugging).

## 3. Virtualization & Re-hydration Protocol
To ensure security and environment independence, MEP uses a placeholder system during export/import:

| Placeholder | Meaning | Export Logic | Import Logic |
| :--- | :--- | :--- | :--- |
| `{{PROJECT_ROOT}}` | Current Workspace | `process.cwd()` -> Placeholder | Placeholder -> `process.cwd()` |
| `{{HOME}}` | User Home Directory | `$HOME` -> Placeholder | Placeholder -> `$HOME` |
| `[EMAIL_REDACTED]` | Personal Emails | Regex match -> Mask | (No restoration) |

## 4. Directory Governance (Hub Layer)
The `hub/` directory serves as the ecosystem's exchange port:
- `hub/exports/missions/`: Outgoing packages.
- `hub/imports/missions/`: Incoming packages (requires validation before deployment).

## 5. Usage Scenarios
- **Best Practice Sharing**: Exporting successful mission blueprints as templates.
- **Anti-Pattern Catalog**: Exporting failed missions with evidence to teach other agents what to avoid.
- **Remote Diagnosis**: Packaging a broken state for expert analysis.
