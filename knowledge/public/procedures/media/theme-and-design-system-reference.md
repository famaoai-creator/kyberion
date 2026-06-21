# Procedure: Theme and Design System Reference

## Goal

Give operators one place to understand what Kyberion currently defines as a theme, what is only a higher-level design system, and how extracted PPTX design fits into that picture.

## Short Answer

`themes.json` is populated enough for the current renderer contract:

- every current theme has `colors` and `fonts`
- the native Kyberion themes also include stable brand defaults
- some themes additionally carry `assets.logo_url`

But `themes.json` is not the full design-system story.

- layout rules live in `slide-layout-presets`
- semantic meaning lives in `semantic-render-tokens`
- profile selection lives in `document-composition-presets`
- cross-artifact binding lives in `media-design-systems`
- imported external visual systems live in `design-md-catalog` and `themes/design-md-imports.json`

## Where Things Live

- Base themes: `knowledge/public/design-patterns/media-templates/themes.json`
- Core theme subset: `knowledge/public/design-patterns/media-templates/themes/themes-core.json`
- Imported DESIGN.md themes: `knowledge/public/design-patterns/media-templates/themes/design-md-imports.json`
- Default theme pointer: `knowledge/public/design-patterns/media-templates/themes/default-theme.json`
- Media design systems: `knowledge/public/design-patterns/media-templates/media-design-systems.json`
- Imported design systems: `knowledge/public/design-patterns/media-templates/media-design-systems/design-md-imports.json`
- Profile presets: `knowledge/public/design-patterns/media-templates/document-composition-presets.json`
- Semantic tokens: `knowledge/public/design-patterns/media-templates/semantic-render-tokens.json`
- Slide layouts: `knowledge/public/design-patterns/media-templates/slide-layout-presets.json`

## Current Native Themes

The native theme catalog currently contains these base themes:

- `kyberion-standard`
- `kyberion-sovereign`
- `executive-neutral`
- `forest-briefing`
- `sunrise-report`
- `aws-architecture`
- `client-a`
- `client-b`

All of them define the same minimum set:

- `colors.primary`
- `colors.secondary`
- `colors.accent`
- `colors.background`
- `colors.text`
- `fonts.heading`
- `fonts.body`

Some themes also define:

- `assets.logo_url`

## Field Coverage Matrix

This is the practical checklist for creating or reviewing a theme.

| Concern | Current home | Defined today | Notes |
| :--- | :--- | :--- | :--- |
| Brand colors | `themes.json` | Yes | Core palette is present for every native theme. |
| Typography | `themes.json` | Yes | Each native theme defines heading and body fonts. |
| Company logo | `themes.json` `assets.logo_url` | Partially | Present for `kyberion-standard` and tenant theme `client-a`; external ADF contracts can carry richer asset sets. |
| Spacing scale | `slide-layout-presets`, `semantic-render-tokens`, imported DESIGN.md systems | Partially | Not modeled as a dedicated theme field; spacing is encoded in layout/semantic catalogs and imported reference systems. |
| Layout structure | `slide-layout-presets` | Yes | Section and slide placement live outside the base theme. |
| Semantic rules | `semantic-render-tokens` | Yes | Meaning-driven spacing, emphasis, and render behavior live here. |
| Profile-to-theme routing | `document-composition-presets`, `media-design-systems` | Yes | These control which theme is used for which artifact profile. |
| External reference style | `themes/design-md-imports.json`, `media-design-systems/design-md-imports.json`, `design-md-catalog` | Yes | Imported systems are explicit reference styles, not implicit defaults. |
| Full design contract | `knowledge/product/schemas/corporate-design-adf.schema.json` | Yes | This is the richer renderer-neutral contract when you need logos, extra assets, slide size, and layout arrays. |
| Web theme pack | `knowledge/product/schemas/web-theme-pack.schema.json` | Yes | Stores palette, typography, hero, spacing, grid, breakpoints, and reusable HTML layout hints. |

## Knowledge Tier Placement

For this repository, the clean separation is:

- `knowledge/public`
  - reusable operator-facing design guidance
  - shared theme catalogs
  - shared design-system catalogs
  - profile presets and layout tokens
- `knowledge/product`
  - internal schemas and policy contracts
  - richer design payloads that are not yet collapsed into the simpler public theme contract
  - selection policies and validation rules

If you are deciding where to add a new design property:

- put stable palette/font defaults in `knowledge/public/design-patterns/media-templates/themes.json`
- put spacing, layout, and section behavior in `slide-layout-presets` or `semantic-render-tokens`
- put richer asset bundles and renderer-neutral design contracts in `knowledge/product/schemas/corporate-design-adf.schema.json`
- put web-specific import contracts in `knowledge/product/schemas/web-theme-pack.schema.json`
- put theme selection policy in `knowledge/product/schemas/presentation-preference-profile.schema.json`

## What Is Defined Today

In the current public theme layer, these items are explicitly defined:

- `colors.primary`
- `colors.secondary`
- `colors.accent`
- `colors.background`
- `colors.text`
- `fonts.heading`
- `fonts.body`
- optional `assets.logo_url`

In the broader design system stack, these items are also explicitly defined:

- profile defaults and recommended themes
- slide and document layouts
- semantic emphasis rules
- imported external brand systems
- extracted source-deck design protocols

## Imported DESIGN.md Systems

Kyberion also imports reference systems from DESIGN.md source packs.

These are not auto-selected by default.

- they are selected explicitly through `design_system_id`
- they may also be recommended when brief keywords match strongly
- they carry more descriptive metadata than native themes

### Claude / designmd-claude

`designmd-claude` is the clearest example of an imported reference system.

What it contributes:

- warm terracotta accent
- parchment-toned canvas
- editorial pacing
- serif-friendly, literary presentation language
- dark-section contrast when needed

How Kyberion uses it:

- as a reference system when an operator wants Claude-like visual language
- as a source for recommendations, not as an implicit default
- as a design vocabulary that can coexist with Kyberion-native governance

What it is not:

- not the default Kyberion house theme
- not a replacement for profile-driven layouts
- not a fully separate rendering engine

## How Kyberion Coordinates Design Systems

The control plane is layered:

1. `document-composition-presets` chooses the default artifact profile and recommended theme
2. `media-design-systems` binds that profile to theme, semantic overrides, layout overrides, and tenant overrides
3. `slide-layout-presets` turns a `layout_key` into actual placement rules
4. `semantic-render-tokens` turns `hero`, `summary`, `evidence`, `control`, and similar labels into renderer behavior
5. `themes.json` supplies the base palette and fonts that those rules consume

This means the theme file is intentionally small.

It should stay small because it is the palette/font layer, not the whole visual policy stack.

## PPTX Extraction Relation

`pptx_extract` now preserves the source deck protocol, including the raw master/theme/layout information.

That matters because:

- a source deck is evidence, not just content
- its theme is the deck's own design truth
- a reusable Kyberion theme can be derived later from the extracted protocol

The practical flow is:

1. extract the deck with `pptx_extract`
2. inspect `layers.raw`
3. derive a reusable theme with `theme_from_pptx_design`
4. derive a reusable layout template with `layout_template_from_pptx_design`

So:

- `themes.json` = Kyberion's governed house palette layer
- `designmd-claude` = an imported reference style
- `pptx_extract` = the source deck's actual visual evidence
- `theme_from_pptx_design` = the bridge from evidence into reusable Kyberion knowledge
- `pptx-theme-pack.schema.json` = the confidential contract for registry-ready PPTX themes
- `web-theme-pack.schema.json` = the confidential contract for registry-ready website themes

## Current Coverage Verdict

For current rendering use, the theme catalog is sufficiently populated.

For full design-system completeness, it is intentionally split across multiple catalogs and should be read as a stack, not a single file.

For PPTX registration specifically, use a confidential `theme.json` pack that carries:

- theme colors and fonts
- optional logo path
- PPTX heritage
  - canvas
  - master
  - raw theme XML
  - raw slide master XML
  - raw layouts
  - master media

For web registration specifically, use a confidential `theme.json` pack that carries:

- theme colors and fonts
- optional logo path
- Web heritage
  - source URL
  - hero structure
  - spacing scale
  - layout grid
  - breakpoints
  - section ordering
  - reusable HTML layout hints

### Known Gaps

- There is no dedicated Digital Agency of Japan imported system in the current catalog snapshot.
- If that style is needed, add it as either:
  - a new imported `designmd-*` reference system, or
  - a native Kyberion theme plus matching semantic/layout overrides

## Operator Rule

- Use `themes.json` when you need a palette and fonts.
- Use `corporate-design-adf.schema.json` when you need logo bundles, slide size, or a richer renderer-neutral contract.
- Use `pptx-theme-pack.schema.json` and its example when you are registering a PPTX-derived theme pack.
- Use `web-theme-pack.schema.json` and its example when you are registering a website-derived theme pack.
- Use `media-design-systems` when you need profile-aware behavior.
- Use `pptx_extract` when you need the source deck's actual design evidence.
