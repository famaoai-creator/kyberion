# Procedure: Generate a Diagram From Document Brief

## 1. Goal
Generate Mermaid, D2, or Draw.io artifacts from the canonical `document-brief` contract.

## 2. Dependencies
- **Actuator**: `Media-Actuator`
- **Schema**: `knowledge/public/schemas/document-brief.schema.json`

## 3. Principle
Separate the diagram into:

- canonical document contract: `document-brief`
- media family: `diagram`
- semantic intent: `document_type`
- business rule profile: `document_profile`
- output engine target: `render_target`
- visual selection: `layout_template_id`

## 4. Step-by-Step Instructions
1. Prepare a `document-brief` JSON file.
2. Set:
   - `artifact_family: diagram`
   - `document_type: <architecture-diagram|process-diagram|...>`
   - `document_profile: <profile>`
   - `render_target: mmd | d2 | drawio`
3. Put:
   - `payload.source` for `mmd` and `d2`
   - `payload.graph` for `drawio`
4. Either:
   - transform through `document_diagram_asset_from_brief` and then render with `mermaid_render`, `d2_render`, or `drawio_write`
   - or render directly with `document_diagram_render_from_brief` for a single-step `brief -> file` flow

## 5. Examples
- [`document-brief-mermaid-diagram.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-actuator/examples/document-brief-mermaid-diagram.json)
- [`document-brief-d2-diagram.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-actuator/examples/document-brief-d2-diagram.json)
- [`document-brief-drawio-diagram.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-actuator/examples/document-brief-drawio-diagram.json)
