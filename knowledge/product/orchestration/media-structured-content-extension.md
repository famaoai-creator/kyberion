# Media Structured-Content Extension Guide

Developer guide for extending the shared structured-section model used by the
`media` write path (docx / pdf / xlsx / pptx). Companion to
[presentation-authoring-playbook](./presentation-authoring-playbook.md), which
documents the _author-facing_ field list.

## Architecture

A `payload.sections[]` entry can carry _structured fields_ — semantic building
blocks (`wbs`, `timeline`, `flow`, `kpi_table`, …) that render as native
constructs in every supported format instead of flattened text.

```
brief.payload.sections[]
        │
        ▼
normalizeStructuredSection(section)      ← libs/actuators/media-actuator/src/media-structured-content.ts
        │  returns StructuredSectionModel (one typed model, all fields
        │  normalized: alias keys, flat/nested forms, string shorthands)
        ▼
   per-format renderers (NOT shared — each emits native constructs)
   ├─ pptx : buildStructuredSlideBody()        media-structured-pptx.ts
   ├─ docx : appendStructuredDocxBlocks()      media-structured-docx.ts
   ├─ pdf  : appendStructuredPdfBlocks()       media-structured-pdf.ts
   │         (flow coords → band-split pages in media-report-pdf-builder.ts)
   └─ xlsx : appendStructuredXlsxSections()    media-structured-xlsx.ts
```

Three rules that keep this sane:

1. **Normalize once.** All alias/shape tolerance lives in
   `media-structured-content.ts`. Renderers read `sm.*` — never the raw
   section.
2. **Never share renderers across formats.** Coordinates/OOXML/vectors/cells
   differ too much; a shared abstraction here becomes a false one.
3. **Propagation is automatic.** `pickStructuredSectionFields(section)` +
   `STRUCTURED_FIELD_KEYS` + `hasStructured(section)` carry new fields through
   every propagation site without per-site edits.

## Canonical model

`StructuredSectionModel` (`media-structured-content.ts`) — the typed surface
renderers consume:

| Key         | Type                                               | Accepted input shapes                                        |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------ |
| `table`     | `{columns, rows, colWidths?, title?}`              | `{columns,rows}` or bare `rows[][]`                          |
| `tables`    | same, plural                                       | array of the above                                           |
| `metrics`   | `[{value,label}]`                                  | objects or `"98% coverage"` strings                          |
| `steps`     | `[{title,description}]`                            | objects or strings                                           |
| `columns`   | `[{title,items}]`                                  | array, or `{left,right,center}`                              |
| `checklist` | `[{text,done}]`                                    | objects or strings                                           |
| `quote`     | `{text,attribution}`                               | object or bare string                                        |
| `image`     | `{path,caption,width?,height?,align?,cols?,rows?}` | object or bare path                                          |
| `cta`       | `string`                                           | string or `{text}`                                           |
| `divider`   | `boolean`                                          | `divider: true`                                              |
| `wbs`       | `[{level,label}]`                                  | nested `{id,name,items                                       | children}`(auto-numbers) or flat`{level,name}` |
| `timeline`  | `[{label,start,end,owner}]`                        | alias: `phase/name/title`, `date/from`, `to`, `assignee`     |
| `matrix`    | `{xAxis,yAxis,quadrants:[{title,items}]}`          | `x_axis`/`y_axis` aliases                                    |
| `process`   | `[{label,description}]`                            | objects or strings                                           |
| `org`       | `[{name,role,level,index,parent}]`                 | nested `reports                                              | children`or flat`{level,name,role}`            |
| `pyramid`   | `[{label,description}]`                            | index 0 = apex, max 6                                        |
| `flow`      | `[{lane,steps:[{label,description}]}]`             | grouped `{lane,steps}` or flat `{lane,label}` (auto-grouped) |
| `roadmap`   | `[{period,title,items}]`                           | `quarter`/`phase` aliases                                    |
| `kpiTable`  | `[{metric,value,target,delta,trend}]`              | `kpi_table` or `kpiTable`, `change`/`direction` aliases      |

## Adding a new field — checklist

Example walkthrough for a hypothetical `callouts_2` field.

### 1. Model + normalizer (`media-structured-content.ts`)

```ts
export interface StructuredFoo {
  /* typed canonical shape */
}

function normalizeFoo(raw: any): StructuredFoo[] {
  // accept tolerant shapes (strings, aliases, flat/nested); emit canonical
}
```

### 2. Wire it into the model

```ts
export interface StructuredSectionModel {
  // … existing …
  foo: StructuredFoo[];
}
export const STRUCTURED_FIELD_KEYS = […, 'foo'] as const;

export function normalizeStructuredSection(section) {
  return { /* … */, foo: normalizeFoo(section?.foo) };
}
```

`hasStructured`, `pickStructuredSectionFields`, and every propagation site now
work for `foo` with zero extra edits.

### 3. Per-format renderers

Add a block in each builder that reads `sm.foo`. Insert position = output order
(currently fixed: table/metrics/steps/columns/checklist/quote/cta →
wbs/timeline/matrix → process/org/pyramid → flow/roadmap/kpiTable → image).
Keep new fields adjacent to their semantic peers.

| Format | File                       | Renderer entry                                                                                             |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| pptx   | `media-structured-pptx.ts` | `buildStructuredSlideBody` — pushes shape/text/table elements                                              |
| docx   | `media-structured-docx.ts` | `appendStructuredDocxBlocks(sm, ctx)` → `ctx.bodyBlocks`                                                   |
| pdf    | `media-structured-pdf.ts`  | `appendStructuredPdfBlocks(sm, ctx, cursorY)` → `elements`/`vectors`/`pageImages`; returns advanced cursor |
| xlsx   | `media-structured-xlsx.ts` | `appendStructuredXlsxSections(sections, ctx)` → `sheetRows` / `sectionMergeCells` / `drawingElements`      |

Renderer conventions:

- **Theme tokens, not literals.** pptx uses `sp()`/`tp()` +
  `ctx.*Color`/`ctx.*Hex`; docx uses `spTw`/`halfPt` + `accentHex`/`surfaceHex`;
  pdf uses `pdfLayout.*` + `headerFill`/`accentFill`/`surfaceFillPdf`/`mutedRgb`.
- **Indivisible blocks call `ensureSpace(needed)`** (pdf) before drawing so
  page-band splitting doesn't tear them. The pdf renderer is a
  pure-pipeline function: it receives `cursorY`, mutates shared
  `elements`/`vectors`/`pageImages`, and returns the advanced cursor —
  `ensureSpace`/`wrapText`/`estimateTextWidth`/`usableH` come in through
  `ctx` so band math stays identical to the builder.
- **docx tables**: `tblCellMar` for cell margins, `trPr.cantSplit` for
  indivisible rows, `tblHeader` on header rows.
- **xlsx**: push `sectionMergeCells` `A<row>:<letter><row>` for any wide text
  row so it isn't clipped by the first column's width.

### 4. Semantic inference (pptx decks only)

`inferredSemantic` in `proposal-pptx-helpers.ts` maps structured fields onto
catalog semantic types when the section doesn't declare one
(`roadmap`, `execution`, `comparison`, `roi`, …). Extend the `nonEmpty`
chain for the new field so auto-deck generation picks a fitting layout.

### 5. Test + verify

- Add a case in `libs/actuators/media-actuator/src/index.test.ts`
  (`extractDocxXml` / worksheet XML / `unzip` assertions — note xlsx cells are
  `inlineStr`, so inspect `xl/worksheets/sheetN.xml`, not sharedStrings).
- `pnpm run build:actuators` then `npx vitest run libs/actuators/media-actuator`.
- Regenerate a four-format probe brief and eyeball pptx/pdf renders
  (`soffice --convert-to pdf` + `pdftoppm` for pptx; `pdftotext` for pdf).

## Ordering contract

Structured blocks emit in a fixed order within a section (see the field list
in step 3), _not_ in authoring order. This is deliberate — the renderer owns
visual rhythm. If section order matters, split into multiple sections.

## Format notes / deliberate asymmetries

| Field      | docx                 | pdf                       | xlsx                  | pptx                     |
| ---------- | -------------------- | ------------------------- | --------------------- | ------------------------ |
| `divider`  | `w:pageBreakBefore`  | fresh page                | extra gap row         | section slide            |
| `cta`      | accent callout band  | accent rect + white text  | info row              | action bar               |
| `timeline` | 期間/項目/担当 table | proportional gantt bars   | span/label/owner cols | gantt or milestone track |
| `process`  | numbered + `↓`       | numbered step rows        | STEP n rows           | boxes + `→`/`↓`          |
| `flow`     | 2-col lane table     | lane label + joined steps | lane/steps rows       | swimlane bars            |

Per-format render differences are intentional — each medium uses its native
visual language rather than pretending to be a pixel-identical render.

## File layout (post-split, ≤1500 lines each — `scripts/check_max_file_lines.ts`)

| File                                    | Role                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `media-structured-content.ts`           | Normalization + canonical model + `STRUCTURED_FIELD_KEYS`/`hasStructured`/`pickStructuredSectionFields`         |
| `media-structured-pptx.ts`              | pptx element emitters                                                                                           |
| `media-report-shared.ts`                | Shared report types + `resolveThemeColorRole`/`hexToPdfRgb`                                                     |
| `media-report-docx-builder.ts`          | DOCX report skeleton (TOC/callouts/body) — calls `appendStructuredDocxBlocks` per section                       |
| `media-structured-docx.ts`              | DOCX structured-field renderers                                                                                 |
| `media-report-pdf-builder.ts`           | PDF report skeleton (title/TOC/callout/tables, page-band split) — calls `appendStructuredPdfBlocks` per section |
| `media-structured-pdf.ts`               | PDF structured-field renderers                                                                                  |
| `media-spreadsheet-pipeline-helpers.ts` | Tracker-grid builder — delegates structured rows to `media-structured-xlsx.ts`                                  |
| `media-structured-xlsx.ts`              | XLSX structured-field renderers                                                                                 |
| `media-layout-runtime.ts`               | Slide layout runtime (zones/patterns) — calls `buildStructuredSlideBody`                                        |

## Common pitfalls

- **`columns` object form** (`{left,right,center}`) is accepted — don't drop
  it when touching `normalizeColumns`.
- **`tables` (plural, `title`)** is a _legacy report-table_ path and stays raw
  (not normalized) — `StructuredTable.title` exists to bridge it.
- **PPTX table rows**: emit `columns` as the first `rows[]` entry — the engine
  treats `rows[0]` as the header.
- **PDF `color` on text elements** must be emitted _outside_ `BT/ET` — the
  engine handles this; don't push color ops into text content.
- **Image extensions**: docx `jpg` → `jpeg` normalization happens in the
  shared model; engines accept `png/jpg/jpeg` — other formats get skipped.
- **`.slice()` caps** are per-field and intentional — raise them in the
  shared normalizer, not per-renderer.
