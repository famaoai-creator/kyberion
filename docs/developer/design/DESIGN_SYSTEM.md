# Kyberion Design System (KDS)

This document defines the canonical brand tokens for Kyberion and how they propagate across our various UI surfaces (Web, Media, Diagram).
It serves as the single source of truth to avoid token drift and duplicate configurations.

For surface-specific implementation details, refer to:
- [Chronos Command Surface Spec](./CHRONOS_A2UI_SPEC.md)
- [Theme and Design System Reference](../../../knowledge/public/procedures/media/theme-and-design-system-reference.md)

## 1. Canonical Tokens

The canonical tokens are defined in a central JSON file:
`knowledge/public/design-patterns/brand-tokens/kyberion.json`

This file specifies:
- **Colors**: Both `light` and `dark` palettes.
- **Fonts**: Defined by `sans` and `mono` families.

## 2. Token Generation Pipeline

To propagate the design tokens to the different interfaces, run the following generation script:

```bash
npx tsx scripts/generate_design_tokens.ts
```
*(Alternatively, run `pnpm pipeline --input ...` if integrated into our regular pipeline).*

This script automatically generates and updates the following files:
1. `presence/displays/chronos-mirror-v2/src/app/globals.css`
2. `presence/displays/operator-surface/src/app/globals.css`
3. `presence/displays/presence-studio/static/design-tokens.css`
4. `presence/displays/computer-surface/static/design-tokens.css`
5. `presence/displays/chronos-mirror-v2/tailwind.config.cjs`
6. `knowledge/public/design-patterns/media-templates/themes.json`

The generated Kyberion token block and theme entries are checked by `pnpm run check:catalogs` so committed files cannot drift from the canonical brand-token JSON.

## 3. Surface Application Patterns

### Web Apps (Next.js with React)
We expose CSS variables with the prefix `--kb-*`.
- Inline styles must reference the CSS variables using `var(--kb-*)`.
- Tailwind is configured to map `kyberion.*` keys to the corresponding CSS variables (e.g., `text-kyberion-primary`).

### Static HTML Surfaces
- Import `design-tokens.css` into the `<head>` of your static file.
- The `body` or `:root` elements should reference `var(--kb-*)` directly instead of hardcoding any HEX or RGBA values.

## 4. Creating a New UI Surface

When building a new UI surface for Kyberion, ensure you follow this checklist:

- [ ] Add the new surface's `globals.css` or `design-tokens.css` path to `scripts/generate_design_tokens.ts`.
- [ ] Run the generation script so that the CSS tokens are written to your new surface.
- [ ] Import the CSS file at the root of your application/page.
- [ ] Ensure all basic styles (background, text color, borders) map to `var(--kb-bg-main)`, `var(--kb-text-primary)`, `var(--kb-border)`, etc.
- [ ] Ensure your `body` tag uses `font-family: var(--kb-font-sans)`.
- [ ] Do **not** hardcode HEX color values in your components. Use the generated CSS variables.
