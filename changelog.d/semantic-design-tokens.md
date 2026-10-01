---
category: Changed
---

- **Artifact engines read colours through semantic design tokens** — spreadsheet status colours, video mode/palette, deck, pptx layout primitives, diagram and docx palettes moved from inline hex into `knowledge/public/design-patterns/semantic-design-tokens.json`, read via `resolveSemanticTokens` (`@agent/core/semantic-design-tokens`). Tenants override them with `theme.semantic_tokens.<engine>` in their design `theme.json`. Default output is unchanged (golden + parity tests); a ratchet test blocks new raw hex in these engines.
