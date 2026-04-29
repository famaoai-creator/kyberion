# Procedure: Generate a Spreadsheet From Document Brief

## 1. Goal
Generate an XLSX artifact from the canonical `document-brief` contract.

## 2. Dependencies
- **Actuator**: `Media-Actuator`
- **Schema**: `knowledge/public/schemas/document-brief.schema.json`

## 3. Principle
Separate the spreadsheet into:

- canonical document contract: `document-brief`
- media family: `spreadsheet`
- semantic intent: `document_type`
- business rule profile: `document_profile`
- output engine target: `xlsx`

## 4. Step-by-Step Instructions
1. Prepare a `document-brief` JSON file.
2. Set:
   - `artifact_family: spreadsheet`
   - `document_type: tracker`
   - `document_profile: <profile>`
   - `render_target: xlsx`
3. Prefer semantic spreadsheet payloads:
   - `payload.columns`
   - `payload.rows`
   - `payload.summary_cards`
   - `payload.row_tone_key`
   - `payload.row_tones`
4. Use `column.validation_key` when the layout template should inject governed list validation.
5. Use a tracker-oriented `layout_template_id` when conditional formatting and overdue rules should come from knowledge-owned defaults.
6. Prefer the canonical route:
   - `document_outline_from_brief`
   - `brief_to_design_protocol`
   - `generate_document`
7. `document_spreadsheet_design_from_brief` remains available only as a compatibility adapter for older flows.

## 5. Example
- [`document-brief-wbs-spreadsheet.json`](../../../../libs/actuators/media-actuator/examples/document-brief-wbs-spreadsheet.json)
- [`document-brief-semantic-tracker-spreadsheet.json`](../../../../libs/actuators/media-actuator/examples/document-brief-semantic-tracker-spreadsheet.json)
