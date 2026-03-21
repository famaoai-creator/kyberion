# Document Brief

`document-brief.schema.json` is the canonical high-level contract for media document generation.

It separates:

- media family: `artifact_family`
- document intent: `document_type`
- business profile: `document_profile`
- output engine target: `render_target`
- locale
- visual selection: `layout_template_id`
- domain payload: `payload`

The intent is to keep:

- business semantics in `document_type` and `document_profile`
- output format in `render_target`
- visual style in `layout_template_id`

This prevents format-specific top-level ADF variants such as invoice-only schema families from proliferating.

Example:

- `artifact_family: document`
- `document_type: invoice`
- `document_profile: qualified-invoice`
- `render_target: pdf`
- `layout_template_id: jp-qualified-invoice-standard`
- `payload: { ...invoice fields... }`

Another example:

- `artifact_family: presentation`
- `document_type: proposal`
- `document_profile: executive-proposal`
- `render_target: pptx`
- `layout_template_id: executive-neutral`
- `payload: { ...proposal fields... }`

Another example:

- `artifact_family: diagram`
- `document_type: architecture-diagram`
- `document_profile: solution-overview`
- `render_target: mmd`
- `layout_template_id: kyberion-sovereign`
- `payload: { source: \"flowchart TD ...\" }`

Another example:

- `artifact_family: spreadsheet`
- `document_type: tracker`
- `document_profile: wbs`
- `render_target: xlsx`
- `layout_template_id: operator-tracker-standard`
- `payload: { columns, rows, row_tone_key, row_tones }`

Another example:

- `artifact_family: document`
- `document_type: report`
- `document_profile: summary-report`
- `render_target: docx`
- `layout_template_id: report-standard`
- `payload: { title, summary, sections }`

Semantic guidance:

- `report` payloads should prefer `sections[].body`, `sections[].bullets`, `sections[].callouts`, and `sections[].tables`
- `tracker` payloads should prefer `columns`, `rows`, `summary_cards`, `row_tone_key`, and `row_tones`
- layout-specific spacing, validation defaults, and conditional formatting rules should live in knowledge-owned layout catalogs, not in top-level schema variants
