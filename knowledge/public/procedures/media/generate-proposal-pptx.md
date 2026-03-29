# Procedure: Generate a Proposal PPTX

## 1. Goal
Generate a proposal deck from a canonical `document-brief` and a knowledge-owned presentation theme.

## 2. Dependencies
- **Actuator**: `Media-Actuator`
- **Schema**: `knowledge/public/schemas/document-brief.schema.json`
- **Theme Catalog**: `knowledge/public/design-patterns/media-templates/themes/`

## 3. Principle
Separate the proposal into:

- canonical document contract: `document-brief`
- media family: `presentation`
- semantic intent: `proposal`
- business rule profile: `document_profile`
- output engine target: `pptx`
- visual selection: `layout_template_id`

## 4. Step-by-Step Instructions
1. Prepare a `document-brief` JSON file.
2. Set:
   - `artifact_family: presentation`
   - `document_type: proposal`
   - `document_profile: <profile>`
   - `render_target: pptx`
   - `layout_template_id: <theme>`
3. Put storyline-related fields under `payload`.
4. Prefer the canonical route:
   - `document_outline_from_brief`
   - `brief_to_design_protocol`
   - `generate_document`
5. `proposal_storyline_from_brief` and `proposal_content_from_storyline` remain useful as narrative inspection tools, but they are not the primary binary generation path anymore.

```bash
node dist/libs/actuators/media-actuator/src/index.js --input libs/actuators/media-actuator/examples/document-brief-proposal-pptx.json
```

## 5. Expected Output
A governed proposal deck that keeps business semantics in the brief and visual variation in knowledge-owned theme selection.
