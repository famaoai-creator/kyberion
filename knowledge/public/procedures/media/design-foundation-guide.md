---
title: Design Foundation v2 — choosing a style and a layout
tags: [design, tokens, styles, layout, pptx, web, video]
last_updated: 2026-09-28
---

# Design Foundation v2 — choosing a style and a layout

Use when a media or web artifact looks generic, or when a fixed scenario's layout is too rigid.
Canonical reference: [DESIGN_SYSTEM.md](../../../../docs/developer/design/DESIGN_SYSTEM.md) · tokens: `knowledge/public/design-patterns/brand-tokens/kyberion-foundation.json`.

## Pick a style (restyles the scenario, no scenario edits)

| Intent                                | Style                | Why                                                   |
| :------------------------------------ | :------------------- | :---------------------------------------------------- |
| Proposals, reports, long-form         | `editorial`          | Serif display, warm paper ground, generous whitespace |
| Product demo, video, operator screens | `midnight-signal`    | Deep navy + one cyan signal colour                    |
| Board / QBR, finance, dashboards      | `graphite-executive` | Graphite neutrals, hairlines, compact density         |
| Marketing, launch, social             | `aurora`             | Violet→cyan gradient accents, round corners           |
| Specs, worksheets, print              | `paper-minimal`      | Near-monochrome, content first                        |
| Anything else                         | omit / `standard`    | Baseline Kyberion look                                |

In a brief: `design_style: "editorial"` (or `design_system_id: "kds-editorial"`, which also re-lays out generic slides). In code: `resolveCreativeDesign({ style })`. In a campaign brief the same `design_style` styles deck, doc, video and landing page together. Tenant branding still overrides the style.

## Pick a composition (free layout)

Name it on a section (`composition: "stat-rail"`), or let `kds-<style>` map it. Read `design_style.preferred_compositions`, or choose from the catalog by the slide's job: statement → `hero-split` / `spotlight`; numbers → `stat-rail`; options → `three-up`; feature overview → `bento-4`; monitoring → `dashboard-grid`; reference → `sidebar-detail`; story → `editorial-asym`. When none fits, author a custom `CompositionSpec` (12 columns × N rows) and run `validateComposition` before use.

## Rules

- Resolve tokens through `resolveCreativeDesign`; never copy hex values or sizes from the JSON into a brief.
- Keep the hard floors (`constraints.min_body_pt`, video minimums) — styles cannot lower them.
- Visual artifacts stay semantic briefs; the style and composition fill positions and styling.
