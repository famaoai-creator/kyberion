# Web Theme Pack Schema

`web-theme-pack.schema.json` defines the confidential artifact used when a source website is imported as a reusable web design.

## What It Stores

- `theme`
  - brand colors
  - typography
  - optional logo URL
- `web`
  - source URL
  - snapshot summary
  - hero structure
  - layout grid
  - spacing scale
  - breakpoints
  - section structure
- `layout_templates`
  - reusable hero/chrome/body-zone skeletons for HTML generation

## Why It Exists

Web pages drift when only colors are stored.

- hero copy and CTA placement get lost
- container widths and spacing scales drift
- section ordering gets rewritten on every regeneration
- responsive breakpoints disappear from the reusable contract

The theme pack keeps those pieces together so `build-web-concept` can render against the imported web design instead of inventing a fresh one.

## Recommended Use

1. `browser:open_tab`
2. `browser:snapshot`
3. `reasoning:synthesize`
4. `media:save_brand_to_confidential`
5. `build-web-concept` with `design_theme`

## Example

See [`web-theme-pack.example.json`](./web-theme-pack.example.json).
