# Procedure: Generate an Invoice PDF

## 1. Goal
Generate an invoice PDF from a canonical `document-brief` and a knowledge-owned media layout template.

## 2. Dependencies
- **Actuator**: `Media-Actuator`
- **Schema**: `knowledge/public/schemas/document-brief.schema.json`
- **Layout Catalog**: `knowledge/public/design-patterns/media-templates/document-layouts.json`
- **Profile Catalog**: `knowledge/public/design-patterns/media-templates/document-composition-presets/` and `knowledge/public/design-patterns/media-templates/artifact-library/`

## 3. Principle
Separate the invoice into:

- canonical document contract: `document-brief`
- layout selection: `layout_template_id`
- business rule profile: `document_profile`

## 4. Step-by-Step Instructions
1. Prepare a `document-brief` JSON file.
2. Set:
   - `artifact_family: document`
   - `document_type: invoice`
   - `document_profile: qualified-invoice`
   - `render_target: pdf`
   - `locale: ja-JP`
   - `layout_template_id: <template>`
3. Put invoice-specific fields under `payload`.
4. Render through `document_pdf_from_brief`.

```bash
node dist/libs/actuators/media-actuator/src/index.js --input libs/actuators/media-actuator/examples/document-brief-invoice-pdf.json
```

## 5. Expected Output
A governed invoice PDF that can switch visual format by updating knowledge templates instead of actuator code. The semantic contract remains stable even when the visual template changes.
