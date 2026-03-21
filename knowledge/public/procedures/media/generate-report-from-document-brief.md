# Procedure: Generate a Report From Document Brief

## 1. Goal
Generate a DOCX or PDF report from the canonical `document-brief` contract.

## 2. Dependencies
- **Actuator**: `Media-Actuator`
- **Schema**: `knowledge/public/schemas/document-brief.schema.json`

## 3. Principle
Separate the report into:

- canonical document contract: `document-brief`
- media family: `document`
- semantic intent: `report`
- business rule profile: `document_profile`
- output engine target: `docx | pdf`

## 4. Step-by-Step Instructions
1. Prepare a `document-brief` JSON file.
2. Set:
   - `artifact_family: document`
   - `document_type: report`
   - `document_profile: <profile>`
   - `render_target: docx | pdf`
3. Put section-oriented content under `payload.sections`.
4. Prefer semantic section blocks instead of raw layout data:
   - `sections[].body`
   - `sections[].bullets`
   - `sections[].callouts`
   - `sections[].tables`
5. Set `layout_template_id` when a governed report style should control spacing and table visuals.
6. Transform through `document_report_design_from_brief`.
7. Render with `docx_render` or `pdf_render`.

## 5. Examples
- [`document-brief-report-docx.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-actuator/examples/document-brief-report-docx.json)
- [`document-brief-report-pdf.json`](/Users/famaoai/k/a/kyberion/libs/actuators/media-actuator/examples/document-brief-report-pdf.json)
