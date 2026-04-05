# DESIGN.md Imports

This catalog contains imported design systems derived from `DESIGN.md` files in the
[`VoltAgent/awesome-design-md`](https://github.com/VoltAgent/awesome-design-md) collection.

## Purpose

Kyberion does not use the raw markdown files directly at render time. Instead, the
collection is normalized into governed catalogs that fit the existing media pipeline:

- `themes/design-md-imports.json`
- `media-design-systems/design-md-imports.json`
- `design-md-catalog/index.json`

This keeps the source material replayable and searchable while preserving Kyberion's
`theme -> design_system -> render` contract.

## Usage

Set an explicit `design_system_id` or `theme` in a media brief:

```json
{
  "document_profile": "executive-proposal",
  "design_system_id": "designmd-apple",
  "render_target": "pptx"
}
```

The imported systems do not auto-bind to profiles by default. They are intended as
reference design systems that can be selected explicitly per brief, project, or service
binding.

When no explicit design system is chosen, Kyberion can still surface
`design_recommendations` from the imported catalog based on the brief semantics.
These recommendations are advisory and do not override the active governed profile.

You can also auto-bind them through project or service-binding metadata:

```json
{
  "metadata": {
    "design_reference": "vercel"
  }
}
```

`design_reference` may match the imported slug, system id, theme id, or brand name.

## Discovery

Use the control CLI:

```bash
pnpm control catalog design-systems
pnpm control catalog design-systems apple
pnpm control catalog design-system designmd-apple
pnpm control catalog design-recommend "developer platform observability"
```

## Regeneration

Refresh the imported catalog after updating the cloned source:

```bash
KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=ecosystem_architect MISSION_ID=MSN-DESIGN-MD-IMPORT \
  pnpm exec tsx scripts/import_design_md_catalog.ts
```
