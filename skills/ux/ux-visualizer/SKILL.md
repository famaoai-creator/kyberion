---
name: ux-visualizer
description: >-

status: implemented
category: Ux
last_updated: '2026-02-16'
tags:
  - automation
  - gemini-skill
arguments:
  - name: input
    short: i
    type: string
    required: true
    description: Input directory or file
  - name: type
    short: t
    type: string
  - name: fidelity
    short: f
    type: string
  - name: output
    short: o
    type: string
    description: Output Mermaid file
  - name: render
    short: r
    type: boolean
    description: Render to image
---

# ux-visualizer

## Capabilities

- **High-Fidelity SPA Mapping**: Generates full-screen representations using Mermaid HTML-labels, capturing layout, colors, and component positioning.
- **State-Based Transitioning**: Visualizes transitions triggered by user actions (hover, scroll, click) rather than just URL changes.
- **Style Extraction**: Maps CSS themes and MUI properties directly into diagram styles.
- **Image Integration**: Renders diagrams to SVG/PNG via `diagram-renderer`.

## Arguments

| Name       | Type    | Description                                                      |
| :--------- | :------ | :--------------------------------------------------------------- |
| --input    | string  | Path to source code directory or requirements file.              |
| --type     | string  | 'screen' (journey), 'state' (logic), or 'component' (structure). |
| --fidelity | string  | 'low' (box-and-line) or 'high' (HTML layout). Default: 'high'.   |
| --output   | string  | Path to save the Mermaid text file.                              |
| --render   | boolean | If true, renders to SVG using diagram-renderer.                  |

## Usage

```bash
# Generate a high-fidelity screen flow from a React SPA
node scripts/cli.cjs run ux-visualizer --input src/App.jsx --type screen --fidelity high --render
```
