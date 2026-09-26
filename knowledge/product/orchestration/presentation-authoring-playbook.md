# Presentation Authoring Playbook

Use this playbook when the user asks for a PowerPoint deck, slides, a briefing pack, or a presentation artifact.
It specializes the shared [Guided Coordination Protocol](knowledge/product/orchestration/guided-coordination-protocol.md) for deck and briefing work.

## Kyberion Fit

Presentation work should be handled as a coordination flow, not as a direct answer.
The value is in brief capture, audience fit, theme selection, source alignment, and reviewable structure.

Use Kyberion when the task has at least one of these properties:

1. It needs a deck, slide outline, or slide-ready narrative.
2. It depends on audience, tone, or brand style.
3. It should compare options, explain a process, or support an approval.
4. It should produce a reusable presentation artifact with source references.

## Brief, Theme, And Pattern Separation

Keep two layers distinct inside the shared coordination flow:

1. Brief layer: what the deck is about, who it is for, and what decision it supports.
2. Theme layer: how the deck should look and feel.
3. Pattern layer: how each slide should be structured.

Use `presentation-preference-profile` to store the reusable theme, slide pattern selection policy, and the first 1-2 questions Kyberion should ask.
Use `slide-pattern-pack` for reusable slide structures derived from proven presentation patterns, including cover, agenda, problem-solution, timeline, KPI, comparison, and action-item layouts.

On first use, Kyberion should register the profile through the
`register-presentation-preference-profile` intent and persist it in the
presentation preference registry. That keeps theme selection and brief
questions out of code and lets the operator refine them as knowledge grows.

## Preflight

Before drafting slides, decide which brief questions, theme, and slide pattern policy to use.

1. Read the stored `presentation-preference-profile`.
2. Pick the brief question set that matches the deck purpose.
3. Pick the theme set that matches the same purpose and audience.
4. Pick the slide pattern selection policy that maps semantic slide intent to concrete structures.
5. Ask only the first 1-2 questions that would materially change the outline, theme, or structural pattern choices.
6. If no profile exists yet, create one in the personal overlay before drafting.

Keep this preflight short. It should decide how to frame the deck, not write the deck itself.

Good fits for this preflight include proposal decks, internal updates, briefing packs, marketing decks, training decks, and comparison slides.

## Workflow

1. Intent capture: preserve the original request and extract known facts.
2. Clarification pass: ask only the questions that change the content brief or theme.
3. Brief draft: create a presentation brief with goal, audience, sources, and constraints.
4. Theme selection: choose a theme hint from the profile, or ask if the choice is unclear.
5. Pattern selection: select a `slide-pattern-pack` pattern for each slide by semantic type, deck purpose, and media kind. Treat theme and structure as separate decisions.
6. Outline: produce the slide story and section structure with `pattern_id` and `slide_pattern` metadata.
7. Approval: pause before generating a final deck if source material or style needs confirmation.
8. Generate: build the deck with the selected brief, theme, and pattern pack.
9. Review: propose reusable preference updates for `knowledge/personal/` only when the user approves.

## Deck Modes

Two structural paths exist, selected by `document_profile` (or `deck_mode`):

- **`executive-proposal` / `vision-proposal` (canonical)** — the deck follows a
  fixed proposal skeleton (cover → executive-summary → why-change →
  solution-shape → governance → delivery-plan → decision). Content binds by
  position from `story.chapters` and `evidence`. Use for actual decision/ask
  decks where the persuasive arc is the point.
- **`generic-deck` (section-driven)** — `document_profile: "generic-deck"` or
  `deck_mode: "sections"`. Each `payload.sections` entry becomes one slide
  (heading → title, body/bullets → content, callouts → callout layouts), plus
  cover and agenda. Use for reports, briefings, and any deck whose structure
  comes from the user's sections rather than the proposal arc.

Sections may carry typed payloads that render as real components instead of
bullet text (semantic_type is inferred when omitted):

| Field                                                | Component                                                                           | Inferred semantic        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `table: {columns, rows, colWidths?}` (or `rows[][]`) | native `<a:tbl>` table with header row                                              | `table`                  |
| `metrics: [{value, label}]`                          | KPI cards (big number + label, accent bar; single metric → centered spotlight card) | `roi`                    |
| `steps: [{title, description}]`                      | chevron process flow                                                                | `roadmap`                |
| `columns: {left                                      | right                                                                               | center: {title, items}}` | rounded comparison cards with headers | `comparison` |
| `checklist: [item]`                                  | two-column check-pill grid                                                          | `appendix`               |
| `quote: {text, attribution?}`                        | large centered quote with accent mark                                               | `summary`                |
| `image: {path, caption?}`                            | embedded figure with caption                                                        | `evidence`               |
| `divider: true`                                      | full-bleed section divider slide                                                    | `hero`                   |
| `cta: "…"`                                           | explicit call-to-action button text on decision slides                              | (decision)               |

Explicit `semantic_type`/`layout_key`/`media_kind`/`section_id` on a section
override the inference. Plain `body`/`bullets` sections still flow through the
body-zone machinery (problem/evidence → callout, control → risk pair,
architecture → panel, summary → statement, contents → agenda).

The same typed fields render across formats:

- **`summary-report` DOCX** — metrics/steps/columns become styled `w:tbl`
  rows, `table` honors `colWidths` in inches, `quote` gets an accent rule,
  `checklist` renders `☐/☑` items, `image` embeds a centered figure.
- **`summary-report` PDF** — metrics/steps/columns become surface-filled
  vector blocks, `table` draws header/grid strokes, `quote` gets an accent
  rule, `image` embeds on the page. The builder paginates automatically:
  flow-space content splits into page bands (usable height ≈ page − top/bottom
  margins), `ensureSpace` keeps cards/quotes/table headers off the break, and
  each page gets a centered page-number footer.
- **`operator-tracker` XLSX** — structured sections append below the grid:
  metrics → info-styled KPI row, steps → header/body row pair, columns →
  side-by-side cells, `table`/`tables` → native grid, checklist → ☐/☑ rows,
  quote → info row, `image` → an anchored drawing spanning ~4 columns × 10
  rows with an optional caption row (row span follows the PNG aspect ratio).
- `divider: true` is a chapter break — deck: section slide; docx:
  `w:pageBreakBefore` on the heading; pdf: the section starts on a fresh
  page; xlsx: an extra gap row. `cta` renders as an accent action bar in
  docx/pdf and an info row in xlsx.
- `wbs` — work breakdown. Nested `[{id, name, items|children}]` auto-numbers
  children (1.1, 1.1.2); flat `[{level, name}]` also works. pptx/pdf/docx
  render an indented tree (accent bar + bold L1, ├/└ connectors); xlsx writes
  merged hierarchy rows.
- `timeline` — schedule entries `[{label, start, end?, owner?}]`. With
  parseable dates (`YYYY[-MM[-DD]]`) pptx/pdf draw proportional bars on a
  shared scale (mini-Gantt, last entry accented); without dates pptx falls
  back to a milestone track. docx renders a 期間/項目/担当 table; xlsx writes
  span/label/owner columns.
- `matrix` — 2×2 quadrant `{x_axis, y_axis?, quadrants:[{title, items}]}`.
  pptx draws a quadrant grid with axis captions (y-axis rotated); docx/pdf
  render surface-filled quadrant cells; xlsx writes merged quadrant rows.
- `process` — ordered flow `[{label, description?}]` (strings also work).
  pptx draws joined boxes (horizontal arrows ≤4 steps, vertical ↓ beyond);
  docx numbers steps with ↓ separators; pdf draws accent-barred step rows;
  xlsx writes STEP n / label / description rows.
- `org` — org chart. Nested `[{name, role?, reports|children}]` or flat
  `[{name, role?, level}]`. pptx draws level rows with elbow connectors;
  docx/pdf render ◆/– indented lines with role suffix; xlsx writes
  indent + role columns.
- `pyramid` — hierarchy layers `[{label, description?}]`, index 0 = apex.
  pptx/pdf draw centered bands that widen toward the base (apex = primary,
  base = accent, middle = surface); docx renders indented centered shaded
  paragraphs; xlsx writes Lv.n rows.
- `flow` — swimlane flow. Grouped `[{lane, steps:[...]|items:[...]}]` or
  flat `[{lane, label}]` (flat entries group by lane in document order).
  pptx draws lane-label bars + connected step boxes with `→`; docx renders a
  two-column lane/steps table; pdf draws a dark lane label + joined step
  text on a surface band; xlsx writes lane | joined-steps rows.
- `roadmap` — period cards `[{period, title?, items?}]` (quarterly/phase
  horizons — unlike `timeline`, periods aren't date-scaled). pptx draws
  card columns with colored period headers; docx/pdf render a period-header
  table row + item rows; xlsx writes period/title/items columns.
- `kpi_table` — `[{metric, value, target?, delta?|change?|trend?}]`. pptx
  renders an emphasized metric/value/目標/変化 row list with accent-colored
  positive deltas; docx renders a headered 指標/現在/目標/変化 table; pdf
  renders emphasized rows; xlsx writes a header + data grid.

Developer guide for adding new fields lives in
[media-structured-content-extension](./media-structured-content-extension.md):
the normalizer/`STRUCTURED_FIELD_KEYS` registration, per-format renderer
conventions, and ordering contract.

- `image` accepts layout hints: `width`/`height` (inches) and
  `align` (`left|center|right`, default center for docx/pdf, left for xlsx).
  xlsx additionally honors `cols`/`rows` (drawing anchor span overrides).
  `caption` doubles as the docx image `descr` (alt text).
- PDF prose wraps to the content width via the shared font-metric
  measurement (`@agent/core/native-pptx-engine/text-metrics` —
  advance-width classes for CJK/latin, CJK breaks anywhere, latin at word
  boundaries):
  body paragraphs, bullets, callouts, quotes, checklist items, column-card
  items, step descriptions and **table cells** (row height follows the
  tallest wrapped cell). Continuation pages carry a running header (doc
  title, top-right) and a centered page number; table header rows repeat
  flush at the top of each continuation band.
- docx tables emit `w:cantSplit` rows (structured blocks never split
  mid-page), `w:tblCellMar` cell margins, `w:tblHeader` header repetition,
  and metric/column cards use white inside-V separators so surface-filled
  cells read as spaced cards.
- xlsx long-text rows (section heading, quote, CTA, checklist item,
  caption) emit `mergeCells` across the section block so values aren't
  clipped by the first column's width.

If a doc-style brief (with `payload.sections`) produces a deck of preset
titles and empty bodies, the canonical path was taken by mistake — switch to
`generic-deck`.

## Outputs

Minimum output:

1. Current assumptions and unresolved blocking questions.
2. Brief summary and chosen theme.
3. Slide outline.
4. Approval preview if anything external or high-risk is needed.
5. Short diagnostics for generic layouts or pattern mismatches after outline generation.

Full output:

1. Presentation brief.
2. Theme selection summary.
3. Slide outline with speaker intent and selected slide pattern IDs.
4. Final deck artifact.
5. Personal preference update proposal.
