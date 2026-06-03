# Diagram Design Knowledge Base

This directory contains the designer-grade intelligence for the `diagram-renderer` skill.

## Knowledge Assets

| File | Purpose | Key Metadata |
| :--- | :--- | :--- |
| `theme-registry.json` | Centralized theme definitions and physical resolution defaults. | Colors, Fonts, Spacing, 16:9 Defaults |
| `design-rules.json` | Intelligent mapping of AI intents to specific rendering strategies. | Intent -> Type/Theme/Layout |
| `design-styles.json` | Advanced CSS injection rules for professional visual polish. | Shadows, Line weights, Typographic tweaks |
| `icon-map.json` | Standardized iconography mapping for all diagram nodes. | Role-to-Icon (PM, Dev, QA, etc.) |

## Governance
These files are managed under the **Ecosystem Architect** role. Any changes here will globally affect the visual output of all AI-generated diagrams across the ecosystem.

## Designer Principles
1. **Physical Standard**: All diagrams default to 1920x1080 (16:9) unless overridden.
2. **Depth over Flatness**: Prefer subtle shadows and varying line weights to convey importance.
3. **Intent over Syntax**: AI should never have to learn Mermaid DSL; it must always use the `gemini-diagram-v1` ADF protocol.
