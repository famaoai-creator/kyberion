---
name: knowledge-portal
description: Launches the Slidev-based dynamic knowledge portal (DeepWiki) to visualize ecosystem state and consensus logs.
status: implemented
category: Documentation
last_updated: '2026-02-14'
tags:
  - gemini-skill
---

# knowledge-portal

## Capabilities
- **Reality-Mirroring**: Displays real-time metrics from `PERFORMANCE_DASHBOARD.md`.
- **Decision Visibility**: Renders ACE Engine's decision logs directly in the UI.
- **Interactive UI**: Contains Vue components to trigger agent analysis from within slides.
- **Exporting**: Supports building static HTML or PDF reports for stakeholders.

## Arguments
| Name | Type | Description |
| :--- | :--- | :--- |
| --dev | boolean | (Default: true) Launches the dev server with HMR. |
| --build | boolean | Builds the static portal for deployment. |

## Usage
```bash
node scripts/cli.cjs run knowledge-portal --dev
```
