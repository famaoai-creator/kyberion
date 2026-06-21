# PPTX Theme Pack Schema

`pptx-theme-pack.schema.json` defines the confidential artifact used when a source PowerPoint is imported as a reusable theme.

## What It Stores

- `theme`
  - brand colors
  - typography
  - optional logo URL
- `pptx`
  - canvas size
  - master slide
  - raw XML passthrough
  - raw layout / master / media entries
- `layout_templates`
  - extracted chrome
  - hero layout
  - body-zone defaults

## Why It Exists

PowerPoint re-creation needs more than a color palette.

- cover slides drift if title and logo placement is lost
- master slides drift if raw heritage is not retained
- section pages drift if body-zone spacing is not preserved

The theme pack keeps those pieces together so `apply_theme` can restore them later.

## Recommended Use

1. `pptx_extract`
2. `theme_from_pptx_design`
3. `save_brand_to_confidential`
4. `apply_theme` with the registered confidential theme name

## Example

See [`pptx-theme-pack.example.json`](./pptx-theme-pack.example.json).
