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

- **Colors**: Both `light` and `dark` palettes (`tokens.colors`). Media (PPTX/video) also consumes these; do not repurpose them for web UI.
- **Fonts**: Defined by `sans` and `mono` families.
- **Web UI layer** (`tokens.ui`, UI-02): semantic `light`/`dark` palettes (`canvas`, `surface`, `surface-raised`, `surface-sunken`, `border`, `border-strong`, `text`, `text-muted`, `text-subtle`, `text-on-accent`, `accent`, `accent-hover`, `accent-soft`, `accent-text`, `focus-ring`, `status.{success,warning,danger,info}.{fg,bg,border}`, `role.<surface>`, `shadow.{sm,md}`) plus `radius`, `space` and two `font_size` scales (`comfortable`, `compact`). Emitted as `--kb-ui-*` CSS variables. `border` is a decorative divider; controls use `border-strong`. Role colors are for badges / active markers only.

## 2. Token Generation Pipeline

To propagate the design tokens to the different interfaces, run the following generation script:

```bash
node --import ./scripts/ts-loader.mjs scripts/generate_design_tokens.ts
pnpm check -- --only ui-ux
```

This script automatically generates and updates the following files:

1. `presence/displays/chronos-mirror-v2/src/app/globals.css` (legacy `--kb-*` block + `--kb-ui-*` block)
2. `presence/displays/operator-surface/src/app/globals.css` (legacy + UI block)
3. `presence/displays/presence-studio/static/design-tokens.css` (legacy + UI block)
4. `presence/displays/computer-surface/static/design-tokens.css` (legacy + UI block)
5. `presence/displays/concierge/src/app/kyberion-ui-tokens.css` (UI block only — concierge themes the legacy `--kb-*` vars at runtime via `/api/theme`)
6. `kyberion-ui.css` next to each of the five token files above (component stylesheet)
7. `presence/displays/chronos-mirror-v2/tailwind.config.cjs`
8. `knowledge/public/design-patterns/media-templates/themes.json` (+ `themes/themes.json`)

The UI block is delimited by `/* kyberion-ui tokens: ... */` … `/* end kyberion-ui tokens */`. Light values are the `:root` default; dark values apply under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`. `[data-density="compact"|"comfortable"]` switches the `--kb-ui-font-size-*` scale for a subtree.

The generated Kyberion token blocks, the UI stylesheets and theme entries are checked by `pnpm check -- --scope full --only catalogs` so committed files cannot drift from the canonical brand-token JSON and the stylesheet source.
`pnpm check -- --only ui-ux` additionally rejects raw colors in operator-surface source, missing semantic / `--kb-ui-*` tokens or component classes in generated files, and dashboard status-vocabulary bypasses. The same check runs in `pnpm validate`, GitHub Actions, and the scheduled `pipelines/ui-ux-governance-audit.json` pipeline.
`scripts/check_design_contrast.ts` holds every `tokens.ui` text pair to WCAG AA 4.5:1 and `border-strong` / `focus-ring` / `accent` to 3:1 on every surface, in both themes.

### Component stylesheet (`kyberion-ui.css`) and the `kyberion-base` catalog

- **Source**: `knowledge/public/design-patterns/web/kyberion-ui.source.css` (base; authored, `--kb-ui-*` variables only, no literal colors, no glass/blur/gradients) plus one file per extension part — `kyberion-ui.charts.source.css` (bar/line/donut/sparkline/heatmap/meter/sequence/flow/stat-list) `kyberion-ui.forms.source.css` (settings/inputs/file-drop/camera-capture/secret-field/save-bar), `kyberion-ui.pads.source.css` (toolbar/dialog/drawing-palette/sketch-board) and `kyberion-ui.voice.source.css` (voice-input/voice-state). `scripts/generate_design_tokens.ts` concatenates the base file first, then every `kyberion-ui.<part>.source.css`, into the generated `kyberion-ui.css` next to each surface's token file. The generator prepends a GENERATED header and replaces `/* @kb-generated status-tones */` with the status-pill tone rules derived from `KB_STATUS_TONES` in `libs/core/surface/a2ui-catalog.ts`. Edit the source files, never the generated copies.
- **Class contract**: one root class per A2UI `ui:*` type — `.kb-app-shell`, `.kb-page-header`, `.kb-nav-rail`, `.kb-tabs`, `.kb-stack`, `.kb-grid`, `.kb-section`, `.kb-next-action`, `.kb-metric`, `.kb-kv`, `.kb-table` (inside `.kb-table-wrap`), `.kb-list`, `.kb-text--{body,muted,caption,mono,title}`, `.kb-status-pill[data-status]`, `.kb-badge[data-tone|data-role]`, `.kb-callout[data-tone]`, `.kb-empty-state`, `.kb-skeleton[data-shape]`, `.kb-btn--{primary,secondary,danger,ghost}`, `.kb-disclosure` (plus the chart and form part classes) — with BEM `__element` children and state in data attributes. Focus rings use `:focus-visible` + `--kb-ui-focus-ring`; animations stop under `prefers-reduced-motion`.
- **Catalog**: `knowledge/product/schemas/a2ui-catalog-kyberion-base.schema.json` (props schema per `ui:*` type) + `libs/core/surface/a2ui-catalog.ts` (`A2UI_BASE_CATALOG_ID`, prop types, `validateA2UIComponentProps`, aliases `text→ui:text`, `button→ui:button`, `card→ui:section`, `container→ui:stack`). `validateA2UIMessage` enforces the props schema for `ui:*` types only; aliases, `display:*`, `kb-*` and `presence.*` keep the structural check. `ui:status-pill` statuses are exactly the `renderStatus()` vocabulary (`listUxStatusValues()` in `ux-vocabulary.ts`).
- **Renderers**: two implementations of the same catalog, kept at prop parity by a shared fixture test. React — `@agent/shared-ui` (`libs/shared-ui/src`, `A2UIRenderer` + one component per `ui:*` type, `src/charts`, `src/forms`) — consumed by the three Next.js surfaces (concierge, chronos-mirror-v2, operator-surface). Vanilla — `libs/shared-ui/vanilla` (dependency-free ES module, `renderA2UI(container, components, options)`) — consumed by the two static-HTML surfaces (presence-studio, computer-surface).
- **i18n**: renderer default copy (status labels, empty states, skeleton reads, chart captions) is never hardcoded; both renderers take a `locale` + vocabulary bundle sourced from the `ui` domain in `knowledge/product/orchestration/user-facing-vocabulary.json` (`en`, `ja`, and `qps-ploc` per `required_locales`). Props text (titles, body, data labels) is translated by the caller before it reaches the renderer.
- **Interactive components (PA-01/PA-02)**: `ui:toolbar` (WAI-ARIA toolbar: buttons, toggles, file pickers, status; `description` tooltips; `sticky` inside a `.kb-sticky-host`), `ui:dialog` (replaces `confirm()` / `prompt()`: input, choices, child content, focus trap that also works inside a shadow root), `ui:drawing-palette`, `ui:sketch-board` (palette + canvas; hands the host a `controller` through `drawing.ready`), `ui:voice-input` (dictation or recording, live input-level meter, push-to-talk, self-contained `chunk_ms` chunks) and `ui:voice-state` (idle / listening / thinking / speaking / muted / error, optional level). Files, audio and images travel only in `onAction` payloads.
- **Talking avatar (PA-09/PA-10)**: `ui:talking-avatar` (expression frames `neutral`/`joy`/`thinking`/`listening` + optional `blink` / `mouth_open` / `speaking`; overlay or frame mouth, `show_state`). The mouth is driven only through the controller in `avatar.ready` (`setLevel` / `attachAnalyser` / `applyCue` / `startSynthetic` / `pulse`, plus `setState` / `setExpression`) — render it once in its own container and never re-render it for a state change. Speech goes through `libs/shared-ui/vanilla/speech-player.js`: browser audio from a surface `…/voice/synthesize` proxy with analyser lip-sync, falling back to `speechSynthesis` (synthetic mouth), or `followHostSpeech` when voice-hub plays on the host; call `unlock()` from the user's send / mic gesture. Shown on 相棒 `/work` + `/ask` (`static/partner-avatar.js`) and in the 秘書室 dock header (`src/app/dock-avatar.tsx`). A user's own avatar set (generated from their photo only after a consent dialog naming the provider) is personal-tier: served only by the owner-only `/api/me/avatar[/:expression]` routes, generated into `avatar/draft/` and promoted by "Use this avatar".
- **Render model**: vanilla `renderA2UI` replaces the whole container on every call. Give each stateful component (`ui:sketch-board`, `ui:voice-input`, `ui:camera-capture`) its own container and do not re-render it while in use; for controlled fields, keep `field.change` values in the page model instead of re-rendering on each keystroke.
- **Gallery**: every `ui:*` component, in light/dark × comfortable/compact × `en`/`ja`, served at presence-studio's `/ui-gallery` (`presence/displays/presence-studio/ui-gallery-routes.ts` + `static/ui-gallery.js`, fixtures in `static/ui-gallery.fixtures*.json`). It is the visual reference for new components and the target of the before/after capture script below.
- **Screenshot capture**: `scripts/capture_surface_screenshots.ts` (`node --import ./scripts/ts-loader.mjs scripts/capture_surface_screenshots.ts --out <dir> [--locales ja,en] [--themes light,dark] [--surfaces …] [--base-url-map '{"concierge":"http://127.0.0.1:3050"}']`) captures the default page list across all 5 surfaces with the shared locale/theme preferences pre-set, for before/after design-change evidence; it assumes the surfaces are already running (see [`docs/SURFACES.md`](../../SURFACES.md)).

## 3. Surface Application Patterns

### Web Apps (Next.js with React)

We expose CSS variables with the prefix `--kb-*`.

- Inline styles must reference the CSS variables using `var(--kb-*)`.
- Tailwind is configured to map `kyberion.*` keys to the corresponding CSS variables (e.g., `text-kyberion-primary`).
- Semantic UI states use `--kb-surface`, `--kb-muted-text`, `--kb-border`, `--kb-success`, and `--kb-danger`; do not infer state colors from brand accents in individual components.

### Static HTML Surfaces

- The local pads (`scripts/*`, `node:http`) use `scripts/lib/pad-ui.ts`: `handlePadUiAsset` serves the vanilla kit, the `ui` message bundle and the generated `scripts/lib/pad-ui/{design-tokens,kyberion-ui}.css`; `resolvePadLocale` picks the locale per request (`?lang` → `kb-ui-locale` cookie → `Accept-Language`); `renderPadPage` / `renderPadHeader` produce the shell with a theme pre-paint (`kyberion.ui.theme` / `kb-ui-theme` cookie) and the shared display controls. Stamped report-review files inline the kit so they work offline.

- Import `design-tokens.css` into the `<head>` of your static file.
- The `body` or `:root` elements should reference `var(--kb-*)` directly instead of hardcoding any HEX or RGBA values.

## 4. Creating a New UI Surface

When building a new UI surface for Kyberion, ensure you follow this checklist:

- [ ] Add the new surface's `globals.css` or `design-tokens.css` path (and its `kyberion-ui.css`) to `scripts/generate_design_tokens.ts`, `scripts/check_catalog_integrity.ts` and `GENERATED_TOKEN_FILES` in `scripts/check_ui_ux_governance.ts`.
- [ ] Run the generation script so that the CSS tokens are written to your new surface.
- [ ] Import the CSS file at the root of your application/page.
- [ ] Ensure all basic styles (background, text color, borders) map to `var(--kb-bg-main)`, `var(--kb-text-primary)`, `var(--kb-border)`, etc.
- [ ] Ensure your `body` tag uses `font-family: var(--kb-font-sans)`.
- [ ] Do **not** hardcode HEX color values in your components. Use the generated CSS variables.

## Design Foundation v2 (KDS v2): more tokens, freer layout

`kyberion.json` stays canonical for brand and semantic tokens. `knowledge/public/design-patterns/brand-tokens/kyberion-foundation.json` adds an **additive** layer so scenarios can look better or be laid out freely without changing any scenario definition:

- **Palette ramps** — `neutral`, `stone`, `brand`, `signal`, `ember`, `moss`, `rose`, `violet` (50–950).
- **Primitive scales** — space (0–96px), radius (`none`…`full`), border width, elevation (`xs`…`2xl`, light/dark), opacity, blur, z-index, motion (duration + easing), type (12-step size ramp, weight, tracking, leading, measure), layout (breakpoints, containers, 12-col grid, aspect ratios), gradients.
- **Styles** — named looks that restyle a fixed scenario: `standard` (baseline), `editorial`, `midnight-signal`, `graphite-executive`, `aurora`, `paper-minimal`. A style overrides palette (per mode), heading face, type-role sizes/weights, radius, elevation, density and gradient. Every style is held to WCAG text 4.5:1 / accent 3:1 in both modes by `libs/core/design-foundation.test.ts`.
- **Compositions** — 12-column region recipes (`hero-split`, `editorial-asym`, `bento-4`, `stat-rail`, `spotlight`, `sidebar-detail`, `three-up`, `dashboard-grid`). `resolveComposition(idOrCustomSpec, { width, height, margins, gutter })` returns absolute rectangles (inches for pptx, px for web/video); pass a custom `CompositionSpec` for a fully free layout. `validateComposition` rejects overflow and overlap (`layer: true` opts in to overlap) and is the ADF preflight for custom layouts.

Use it through the single entry point — never read the JSON in a surface:

```ts
const design = resolveCreativeDesign({ surface: 'pptx', style: 'editorial', tenantSlug });
// design.colors / fonts / typography are restyled; design.design_style.preferred_compositions
// suggests layouts; design.foundation_css_vars carries --kds-* for web/video.
const regions = resolveComposition(design.design_style!.preferred_compositions[0], {
  width: 10,
  height: 5.625,
  margins: [0.3, 0.35, 0.3, 0.35],
  gutter: 0.15,
});
```

Precedence is **brand tokens → style → tenant override** (a tenant's palette/fonts always win). Omitting `style`, or passing `standard` or an unknown id, is a strict no-op. `resolvePptxSurfaceDesign(tenantSlug, style)` accepts the style for the native PPTX engine.

**Where it is wired in (so it is actually used):**

| Output                                 | How to select                                                                                    | What changes                                                                                                                                                                                                                                                                                    |
| :------------------------------------- | :----------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PPTX / DOCX / XLSX via media-actuator  | brief `design_style: "<style>"`, or `design_system_id: "kds-<style>"`, or `theme: "kds:<style>"` | palette, heading face, type ramp, panel/hairline/header roles; `kds-<style>` also maps generic semantic types (content, summary, problem, solution, comparison, metrics/roi) to compositions. Specialised zones (hero, contents, architecture, timeline, decision_cta) keep their own geometry. |
| A single slide                         | section `composition: "<composition-id>"`                                                        | that slide's body is laid out from the composition (`kds-<id>` zone)                                                                                                                                                                                                                            |
| Automatic deck theme choice            | none of the above given                                                                          | KDS styles are candidates for story-matched selection alongside the base themes                                                                                                                                                                                                                 |
| Campaign (deck + doc + video + web LP) | `campaign-brief` `design_style`                                                                  | one style resolved once per surface; video gets `--kds-*` css_vars, the landing page gets radius/shadow, deck/doc get the brief style                                                                                                                                                           |
| Image / video / music prompts          | params `design_style`                                                                            | style palette, tone words and anti-patterns in the style block                                                                                                                                                                                                                                  |

Composition regions map body lines in reading order: kicker/side ← objective, card/kpi ← one line each (the last tile of a body-less composition takes all remaining lines), body ← the rest, caption ← call to action. Title, subtitle and visual regions belong to slide chrome or imagery.

Web: `knowledge/public/design-patterns/web/kyberion-ds.css` (generated by `node --import ./scripts/ts-loader.mjs scripts/generate_design_foundation.ts`; drift is caught by `design-foundation.test.ts`) defines `--kds-*` primitives, `[data-kds-style="<id>"]` scopes (with `data-theme` light/dark handling identical to `--kb-ui-*`) and `.kds-comp-<id>` grid classes whose children are placed by `data-region="<region-id>"`.

### KDS v2 on the Surfaces

Every Surface token file (`globals.css` / `design-tokens.css` / `kyberion-ui-tokens.css`) now also carries one `[data-kds-style="<id>"]` scope per style, generated by `scripts/generate_design_tokens.ts` into the same `--kb-ui-*` block. A style **re-declares the same semantic tokens** the components already read (canvas, surface, text, accent, borders, radius, shadow) plus `--kb-ui-font-heading` and `--kb-ui-gradient-accent`; components never branch on a style. Set `data-kds-style="<id>"` on `<html>` (light/dark and density work as before). Without the attribute nothing changes.

The palette is _derived_ (`libs/core/design-foundation-ui.ts`), not hand-written, so each value has a stated reason: canvas/text/accent come from the style; muted/subtle text, borders and focus ring are pushed to the WCAG floors (4.5:1 text, 3:1 boundaries) against every surface; status/role/viz colours keep their hue and meaning and only their lightness moves. `scripts/check_design_contrast.ts` holds every style × theme to the same pairs as the base palette, so a style is legible on the Surfaces or it does not ship.

Gradients: the old "no gradient backgrounds" rule is revised. Gradients are allowed only through `--kb-ui-gradient-accent` (primary controls), which is `none` unless a style opts in with `surface_gradient` (currently `aurora`); its stops are derived so the button ink keeps 4.5:1 on every stop.

Selection is not wired into the Surfaces' display preferences yet. Evaluate with the style toggle (or `?style=<id>`) on the presence-studio `/ui-gallery`; it previews only and never writes a shared choice.

## Tenant Branding (DS-02)

Tenant-specific branding overlays the canonical tokens through one shared resolver:

- **Resolver**: `libs/core/organization/tenant-design-resolver.ts` (`resolveTenantDesign({ customerId | brandName | designSystemId })`). Sources: `customer/<slug>/design/tenant-override.json` (bound customers) and `knowledge/confidential/<tenant>/design/tenant-override.json` (+ `theme.json`, `layout-templates.json`, `assets/logo.png`).
- **Consumers**: media-actuator (PPTX/theme packs), video content briefs (VDS-07), and chronos-mirror `/api/tenant-design` (css_vars for UI theming; guarded by the standard chronos API auth).
- **Tier isolation (acceptance 4, pinned by tests)**: with no tenant context the resolver returns `source: 'default'` and never reads confidential values into the result; non-matching contexts do not fall through to another tenant. See `tenant-design-resolver.test.ts` (DS-02 tier isolation suite).

To onboard a tenant's branding: place `tenant-override.json` (matchers + branding + `theme_pack_path`) under the tenant's confidential design directory — no code changes required.
