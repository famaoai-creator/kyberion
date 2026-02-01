---
name: test-genie
description: Executes the project's test suite and returns the output for AI analysis.
---

# Test Genie Skill

Executes the project's test suite and returns the output. It attempts to auto-detect the test command (npm, pytest, etc.).

## Usage

```bash
node test-genie/scripts/run.cjs <project_root> [custom_command]
```