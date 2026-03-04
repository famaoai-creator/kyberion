---
name: diagram-renderer
status: implemented
category: Media
last_updated: '2026-03-01'
protocol: gemini-diagram-v1
tags: gemini-skill
---

# Diagram Renderer (Protocol v1)

## Overview
This skill is the official implementation of the **Gemini Diagram ADF Protocol v1**. It decouples AI logic from visualization syntax, allowing Gemini to generate professional-grade diagrams (Flowcharts, Gantt, Sequence, ER, etc.) by providing pure data.

## Capabilities

### 1. Intent-Driven Rendering
Automatically selects the best visualization strategy based on user intent:
- `system_architecture`: Symmetric, icon-rich maps.
- `project_roadmap`: 16:9 top-axis Gantt charts.
- `api_sequence`: Modern tech-dark sequence diagrams.
- `db_schema`: Professional ER diagrams.
- `strategy_map`: Business-friendly forest themed maps.

### 2. Designer Finish (Automatic)
Every output is physically standardized to **16:9 (1920x1080)** and features:
- **Depth**: Auto-injected drop shadows and gradients.
- **Typography**: Refined fonts (Segoe UI / Fira Code) and spacing.
- **Branding**: Unified theme support (`base`, `dark`, `forest`).

## Usage (ADF Protocol)

AI agents should provide a JSON file conforming to `schemas/diagram-adf.schema.json`.

```json
{
  "protocol": "gemini-diagram-v1",
  "intent": "project_roadmap",
  "title": "Q1 Development",
  "elements": {
    "nodes": [
      { "id": "n1", "name": "Phase 1", "section": "Planning", "start": "2026-03-01", "duration": "7d" }
    ]
  }
}
```

```bash
node dist/index.js --input input.json --out output.svg
```

## Extension Points
- **`themeVariables`**: Override specific colors or fonts.
- **`customStyle`**: Inject custom CSS properties.
- **`elements.diagram`**: Passthrough for raw Mermaid code when specialized tweaks are needed.

## Knowledge Registry
- `theme-registry.json`: Global theme and resolution defaults.
- `design-rules.json`: Mapping of intents to rendering strategies.
- `design-styles.json`: Advanced CSS override injection rules.
