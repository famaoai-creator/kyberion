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
node --import ./scripts/ts-loader.mjs scripts/generate_design_tokens.ts
pnpm check:ui-ux
```

This script automatically generates and updates the following files:

1. `presence/displays/chronos-mirror-v2/src/app/globals.css`
2. `presence/displays/operator-surface/src/app/globals.css`
3. `presence/displays/presence-studio/static/design-tokens.css`
4. `presence/displays/computer-surface/static/design-tokens.css`
5. `presence/displays/chronos-mirror-v2/tailwind.config.cjs`
6. `knowledge/public/design-patterns/media-templates/themes.json`

The generated Kyberion token block and theme entries are checked by `pnpm run check:catalogs` so committed files cannot drift from the canonical brand-token JSON.
`pnpm check:ui-ux` additionally rejects raw colors in operator-surface source, missing semantic tokens, and dashboard status-vocabulary bypasses. The same check runs in `pnpm validate`, GitHub Actions, and the scheduled `pipelines/ui-ux-governance-audit.json` pipeline.

## 3. Surface Application Patterns

### Web Apps (Next.js with React)

We expose CSS variables with the prefix `--kb-*`.

- Inline styles must reference the CSS variables using `var(--kb-*)`.
- Tailwind is configured to map `kyberion.*` keys to the corresponding CSS variables (e.g., `text-kyberion-primary`).
- Semantic UI states use `--kb-surface`, `--kb-muted-text`, `--kb-border`, `--kb-success`, and `--kb-danger`; do not infer state colors from brand accents in individual components.

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

## Tenant Branding (DS-02)

Tenant-specific branding overlays the canonical tokens through one shared resolver:

- **Resolver**: `libs/core/tenant-design-resolver.ts` (`resolveTenantDesign({ customerId | brandName | designSystemId })`). Sources: `customer/<slug>/design/tenant-override.json` (bound customers) and `knowledge/confidential/<tenant>/design/tenant-override.json` (+ `theme.json`, `layout-templates.json`, `assets/logo.png`).
- **Consumers**: media-actuator (PPTX/theme packs), video content briefs (VDS-07), and chronos-mirror `/api/tenant-design` (css_vars for UI theming; guarded by the standard chronos API auth).
- **Tier isolation (acceptance 4, pinned by tests)**: with no tenant context the resolver returns `source: 'default'` and never reads confidential values into the result; non-matching contexts do not fall through to another tenant. See `tenant-design-resolver.test.ts` (DS-02 tier isolation suite).

To onboard a tenant's branding: place `tenant-override.json` (matchers + branding + `theme_pack_path`) under the tenant's confidential design directory — no code changes required.
