# Design Narrative By Document Profile

Kyberion now separates three concerns for document-like media generation:

- `document_profile`
  - what kind of artifact is being produced
- `narrative_pattern_id`
  - how the story or table of contents should unfold
- `layout_key` / `media_kind`
  - how each section should be presented

The generation boundary is:

- LLM
  - drafts content and normalizes intent
- knowledge
  - owns `document_profile`, `sections`, semantic rules, and design rules
- compiler
  - maps profile-driven structure into design protocol
- renderer
  - materializes binary output

Reference:

- [media-document-generation-boundary.md](../../architecture/media-document-generation-boundary.md)

The preset catalog is stored as directory-scanned knowledge packs at:

- [media-design-systems](../../design-patterns/media-templates/media-design-systems/defaults.json)
- [document-composition-presets](../../design-patterns/media-templates/document-composition-presets/defaults.json)
- [slide-layout-presets](../../design-patterns/media-templates/slide-layout-presets/defaults.json)
- [semantic-render-tokens](../../design-patterns/media-templates/semantic-render-tokens/defaults.json)
- [artifact-library](../../design-patterns/media-templates/artifact-library/project-mgmt-high-fidelity.json)
- [design-md-catalog](../../design-patterns/media-templates/design-md-catalog/README.md)

`document-composition-presets` contains the curated default profiles for common Kyberion flows.

`artifact-library` contains the wider high-fidelity profile corpus and is also scanned into the same profile resolver, so domain packs can extend the media catalog without editing code.

`design-md-catalog` contains imported DESIGN.md-derived design systems. These are reference visual systems that can be selected explicitly with `design_system_id`, and they resolve through the same `theme -> design_system -> semantic/layout override` path as native Kyberion systems. When no explicit imported system is selected, Kyberion may still emit `design_recommendations` based on the brief semantics.

## Current Profiles

- `executive-proposal`
  - problem-solution executive deck
  - sections:
    - cover
    - executive-summary
    - why-change
    - target-outcome
    - solution-shape
    - governance
    - delivery-plan
    - decision
- `vision-proposal`
  - future-vision deck
- `summary-report`
  - title / summary / section flow / appendix
- `operator-tracker`
  - overview / execution board / signals
- `solution-overview`
  - diagram-first solution framing
- `artifact-library/*`
  - high-fidelity PM, requirements, architecture, quality, ops, governance, legal, HR, finance, sales, marketing, and general document profiles
  - scanned together with the curated preset catalog
- `designmd-*`
  - imported external visual systems such as `designmd-apple`, `designmd-stripe`, `designmd-vercel`, `designmd-claude`
  - selected explicitly through `design_system_id` rather than auto-bound to profiles
  - may also appear in `design_recommendations` when the brief strongly matches their imported keywords and description

## ADF Usage

The canonical path is now:

1. `document_outline_from_brief`
2. `brief_to_design_protocol`
3. `generate_document`

Legacy medium-specific operators still exist as compatibility adapters, but they should not be the primary integration path for new flows.

To materialize the recommended structure from a brief:

```json
{
  "type": "transform",
  "op": "document_outline_from_brief",
  "params": {
    "from": "last_json",
    "export_as": "document_outline"
  }
}
```

To generate a proposal storyline using the preset:

```json
{
  "type": "transform",
  "op": "proposal_storyline_from_brief",
  "params": {
    "from": "last_json",
    "export_as": "proposal_storyline"
  }
}
```

To go directly from profile-aware brief/data to a binary artifact:

```json
{
  "type": "apply",
  "op": "generate_document",
  "params": {
    "profile_id": "requirements-definition",
    "render_target": "pptx",
    "output_path": "active/shared/exports/requirements-definition.pptx",
    "data": {
      "title": "Requirements Definition",
      "summary": "Baseline for scope, requirements, controls, and traceability."
    }
  }
}
```

The generation rule is:

- `document_profile`
  - selects the governed knowledge template
- `sections`
  - if present in the selected profile, they are the source of truth for composition
- `document_type`
  - acts as fallback taxonomy only
- `render_target`
  - chooses the physical renderer last

The resulting outline or storyline includes:

- `design_system_id`
- `design_recommendations`
- `narrative_pattern_id`
- `recommended_theme`
- `recommended_layout_template_id`
- `toc`
- per-section `media_kind`
- per-section `layout_key`

At render time, `layout_key` is resolved against the slide layout preset catalog so sections like:

- `evidence-callout`
- `timeline-roadmap`
- `decision-cta`
- `immersive-vision`
- `three-pillars`

can render with different placement and visual emphasis instead of a single generic slide layout.

For non-slide artifacts, the same profile-driven model now also carries forward as governed composition metadata:

- reports
  - classify sections such as `doc-sections` vs `doc-appendix`
  - carry `composition` metadata into docx/pdf design payloads
- trackers
  - carry `sheetRoles` and `composition` metadata into xlsx design payloads
  - default the primary worksheet name from the profile section title such as `Execution Board`

`semantic-render-tokens` is the governed contract for media-agnostic meaning such as:

- `summary`
- `evidence`
- `control`
- `appendix`
- `signals`
- `execution`

Renderers use those semantic tokens to decide things like:

- pdf section header color and emphasis block behavior
- callout fill treatment
- tracker signal priority ordering

`media-design-systems` is the higher-order switchboard that binds:

- profile -> default theme
- profile -> semantic overrides
- profile -> slide layout overrides
- profile -> branding defaults
- tenant/client matcher -> theme and branding override

So Kyberion can change an entire artifact family look-and-feel by switching a governed design system instead of editing code.

Because the loader now scans directories instead of a single monolithic JSON file, profile expansion can happen by adding new domain packs under `artifact-library/` or new focused preset files under the other media-template directories.

Imported DESIGN.md systems can be refreshed with:

```bash
KYBERION_PERSONA=ecosystem_architect MISSION_ROLE=ecosystem_architect MISSION_ID=MSN-DESIGN-MD-IMPORT \
  pnpm exec tsx scripts/import_design_md_catalog.ts
```

And discovered with:

```bash
pnpm control catalog design-systems
pnpm control catalog design-systems apple
pnpm control catalog design-system designmd-apple
pnpm control catalog design-recommend "premium cinematic consumer launch"
```

## Design Intent

This model allows Kyberion to define:

- document-specific table of contents
- media-type-specific visual intent
- layout hints per section
- section and sheet composition metadata for downstream renderers
- semantic render rules governed from knowledge rather than hardcoded in code
- profile-level design system switching from governed knowledge
- richer presentation expansion than chapter-by-chapter filler
- render-time visual differences driven by governed knowledge catalogs
