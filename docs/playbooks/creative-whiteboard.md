# 🎨 Playbook: Creative Whiteboard (Sketch-to-Code)

This playbook outlines the workflow for converting hand-drawn sketches or UI ideas into functional code and diagrams using the Presence Layer.

## 📋 Prerequisites
- Camera or Screenshot permissions granted.
- `visual-imagination` skill configured.
- Gemini 1.5 Pro or Flash (Multimodal) active.

## 🛠️ Workflow Steps

### 1. Capture the Inspiration
Take a photo of your whiteboard, sketch, or a reference UI.
```bash
node scripts/cli.cjs system visual-capture camera
```

### 2. Multimodal Analysis
The Agent reads the captured artifact and describes the layout, components, and intent.
*Note: This is currently performed by the Agent's core intelligence when an image path is provided.*

### 3. Diagram Generation (ADF)
Convert the description into a Mermaid diagram for structural verification.
```bash
# Agent-internal: use diagram-renderer
node scripts/cli.cjs run diagram-renderer --input "<description>"
```

### 4. Code Generation
Generate a React (TypeScript) or HTML/CSS prototype based on the visual input.
```bash
# Agent-internal: use boilerplate-genie or refactoring-engine
node scripts/cli.cjs run boilerplate-genie --prompt "Create a React component based on the visual-capture artifact /active/shared/captures/latest.png"
```

## 💡 Examples
- **Sketch to UI**: Drawing a simple dashboard -> React Component.
- **Architecture to Mermaid**:構成図のスケッチ -> Mermaid Class Diagram.
