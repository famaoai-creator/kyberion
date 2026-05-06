# Kyberion Design System (KDS): Sovereign Command

This document defines the visual theme and UX principles for Kyberion, specifically for the **Chronos Mirror** control surface.

## 1. Core Philosophy: "Deep Space Intelligence"

Kyberion's UI represents a high-fidelity control tower for autonomous agents. It prioritizes clarity, technical authority, and "living" state visibility.

### Visual Pillars
- **Depth:** Layers of data floating in a dark, structured void.
- **Pulse:** Subtle animations indicating agent reasoning and system vitality.
- **Precision:** Monospace data alignment and strict geometric grids.

## 2. Color Palette

| Name | Hex | Usage |
| :--- | :--- | :--- |
| **Solid Obsidian** | `#020617` | Main Background |
| **Kyberion Blue** | `#0A192F` | Panel Backgrounds, Depth Layers |
| **Pulse Cyan** | `#00F2FF` | Active States, Primary Accents, Progress |
| **Amber Logic** | `#FFAB00` | Warnings, Intervention Required, Pending Approvals |
| **Steel Ghost** | `#94A3B8` | Secondary Text, Disabled States, Grid Lines |
| **Pure Logic** | `#F8FAFC` | Primary Typography, High Contrast Data |

## 3. Typography

- **Headings:** `Inter` (Bold, Tracking: -0.02em) - Modern authority.
- **Body:** `Inter` (Regular) - Readability at scale.
- **Data/Logs:** `JetBrains Mono` - Precision and engineering alignment.

---

# A2UI Component Specification for Chronos

These components map directly to the `Component.type` in the A2UI message protocol.

## 1. Layout Components

### `kb-layout-grid`
- **Purpose:** Defines the main structural areas of the surface.
- **Props:**
  - `columns`: number
  - `gap`: string (e.g., "1rem")
  - `variant`: "dashboard" | "mission-focus"

## 2. Information & State Components

### `kb-status-orbit` (The "Intent Loop")
- **Purpose:** Visualizes the `Intent -> Plan -> State -> Result` lifecycle.
- **Props:**
  - `currentPhase`: "intent" | "plan" | "state" | "result"
  - `status`: "running" | "blocked" | "completed" | "failed"
  - `label`: string (Main status text)

### `kb-mission-card`
- **Purpose:** Represents a single mission or task session.
- **Props:**
  - `missionId`: string
  - `title`: string
  - `owner`: string (Agent name)
  - `progress`: number (0-100)
  - `priority`: "low" | "medium" | "high" | "critical"

### `kb-artifact-tile`
- **Purpose:** Previews produced files or data.
- **Props:**
  - `type`: "code" | "image" | "document" | "log"
  - `path`: string
  - `previewContent`: string (truncated)

## 3. Interaction Components

### `kb-intervention-panel`
- **Purpose:** Prompts the operator for input or approval.
- **Props:**
  - `reason`: string
  - `options`: Array<{ label: string, value: string, variant: "primary" | "secondary" | "danger" }>
  - `isBlocking`: boolean

---

## 4. CSS Variable Mapping (Implementation Reference)

```css
:root {
  --kb-bg-main: #020617;
  --kb-panel-bg: rgba(10, 25, 47, 0.8);
  --kb-accent: #00F2FF;
  --kb-warning: #FFAB00;
  --kb-text-primary: #F8FAFC;
  --kb-text-secondary: #94A3B8;
  --kb-font-sans: 'Inter', sans-serif;
  --kb-font-mono: 'JetBrains Mono', monospace;
  --kb-blur: blur(12px);
  --kb-border: 1px solid rgba(148, 163, 184, 0.1);
}
```
