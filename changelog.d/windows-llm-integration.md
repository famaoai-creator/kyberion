---
category: Fixed
---

- Refresh Windows local AI availability immediately when enabled state, endpoint or model changes; suppress pending prompts across configuration changes and accept OpenAI base URLs ending in `/v1`.
- Discover native Claude executables on Windows using OS path semantics, including quoted PATH directories, while excluding project shims and duplicate paths.
- Return portable separators from repository-relative path conversion on Windows so scoped autonomous execution can record outcomes without relaxing resource grants.
