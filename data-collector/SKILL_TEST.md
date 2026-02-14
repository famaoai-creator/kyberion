---
name: codebase-mapper
description: Maps the directory structure of the project to help the AI understand the codebase layout.
---

# Codebase Mapper Skill

Maps the directory structure of the project to help the AI understand the codebase layout.

## Usage

```bash
node codebase-mapper/scripts/map.cjs <directory_path> [max_depth]
```

- `<directory_path>`: Root directory to map (default: `.`)
- `[max_depth]`: How deep to traverse (default: `3`)
