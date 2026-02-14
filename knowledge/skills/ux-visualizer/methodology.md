# Methodology: High-Fidelity SPA Reverse Engineering

SPA (Single Page Applications) require a different visualization strategy than traditional multi-page apps. This document defines the protocol for `ux-visualizer`.

## 1. State vs. Page
- **Traditional**: Link A -> Page B.
- **SPA**: Viewport A + Action (Scroll/Click) -> Viewport State B.
- **Protocol**: Each "Screen" in the flow must represent a full-screen state, including overlays (modals, drawers) and scroll positions.

## 2. Visual Fidelity Protocol (HTML-in-Mermaid)
To achieve "real-world" appearance in text-based diagrams:
- Use `graph TD` or `graph LR`.
- Define nodes using HTML-like syntax: `Node["<div style='...'>...</div>"]`.
- **Layout Keys**:
    - `display: flex; justify-content: space-between;` for Headers.
    - `display: grid; grid-template-columns: 1fr 1fr;` for Product Grids.
    - `position: relative;` + `absolute;` for Hover effects and Overlays.

## 3. Style Mapping (CSS to Mermaid)
- **Primary Color**: Extract from `NavBar` or `Theme` (e.g., `#303454`).
- **Accent Color**: Extract from `Buttons` or `Active States` (e.g., `#fc4d7d`).
- **Font**: Use `font-family: cursive` if the source code specifies it for titles.

## 4. Extraction Checklist
1. **App.jsx**: Determine the global layout order.
2. **NavBar**: Identify global navigation and search/cart entry points.
3. **Interactions**: Grep for `onMouseEnter`, `onClick`, `Drawer`, and `useState` to identify state-transition triggers.
4. **Images**: Capture CDN URLs to make the diagram look authentic.

---
*Created: 2026-02-14 | Ecosystem Architect*
