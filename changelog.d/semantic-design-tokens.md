---
category: Changed
---

- **Artifact engines read colours through semantic design tokens** — spreadsheet status colours, video mode/palette, deck, pptx layout primitives, diagram and docx palettes moved from inline hex into `knowledge/public/design-patterns/semantic-design-tokens.json`, read via `resolveSemanticTokens` (`@agent/core/semantic-design-tokens`). Tenants override them with `theme.semantic_tokens.<engine>` in their design `theme.json`; overlay values are validated per engine (OOXML engines — spreadsheet / pptx / docx / layout — accept only 6-digit hex; CSS engines — deck / video / diagram — only hex, rgb(a) or hsl(a), never `url(`, `var(` or `expression(`) and invalid values are dropped with one warning. Default output is unchanged (golden + parity tests); a ratchet test blocks new raw hex in these engines.
