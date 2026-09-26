/** XLSX structured-section renderers — extracted from
 * `media-spreadsheet-pipeline-helpers.ts` (file-length policy). Appends
 * normalized structured fields (see `media-structured-content.ts`) as
 * worksheet rows below the tracker grid.
 */
import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { getPngDisplaySize } from './media-layout-catalog.js';
import { normalizeStructuredSection } from './media-structured-content.js';

export function columnNumberToLetter(input: number): string {
  let n = Math.max(1, Math.floor(input));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function inferPrimitiveCellType(value: any): 'n' | 'b' | 'd' | 's' {
  if (typeof value === 'number') return 'n';
  if (typeof value === 'boolean') return 'b';
  if (value instanceof Date) return 'd';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return 'd';
  return 's';
}

export interface XlsxStructuredSectionCtx {
  /** Destination row list (mutated). */
  sheetRows: any[];
  /** Merge ranges for wide text rows (mutated). */
  sectionMergeCells: Array<{ ref: string }>;
  /** Drawing elements (images) appended (mutated). */
  drawingElements: any[];
  /** Tracker grid columns (used for the merge span width). */
  columns: any[];
  /** Tracker body rows — structured sections start after these. */
  rows: any[];
  /** First data row index of the tracker body. */
  dataStartIndex: number;
  /** Style indices by role. */
  styleMap: Record<string, number>;
  /** Report layout tokens (banded_rows etc.). */
  layout: any;
  /** Repo root for image path validation. */
  rootDir: string;
}

/**
 * Append every structured section below the tracker grid.
 * Sections without structured fields are skipped so plain tracker briefs
 * keep their original shape.
 */
export function appendStructuredXlsxSections(
  structuredSections: any[],
  ctx: XlsxStructuredSectionCtx
): void {
  const {
    sheetRows,
    sectionMergeCells,
    drawingElements,
    columns,
    rows,
    dataStartIndex,
    styleMap,
    layout,
    rootDir,
  } = ctx;
  let sectionRow = dataStartIndex + rows.length + 1;
  // Wide text rows (headings/quotes/checklist) merge across the section
  // block so long values aren't clipped by the first column's width.
  const mergeSpanLetter = columnNumberToLetter(Math.max(columns.length, 8));
  for (const section of structuredSections) {
    const sm = normalizeStructuredSection(section);

    if (sm.divider) {
      // Chapter break semantics in a sheet = a wider visual gap.

      sectionRow += 1;
    }

    if (section.heading) {
      sheetRows.push({
        index: sectionRow,

        height: layout.header_row_height || 22,

        customHeight: true,

        cells: [
          {
            ref: `A${sectionRow}`,

            type: 's',

            value: String(section.heading),

            styleIndex: styleMap.section,
          },
        ],
      });

      sectionMergeCells.push({ ref: `A${sectionRow}:${mergeSpanLetter}${sectionRow}` });

      sectionRow += 1;
    }

    const metrics = sm.metrics.slice(0, 12);

    if (metrics.length > 0) {
      sheetRows.push({
        index: sectionRow,

        cells: metrics.map((metric, index) => ({
          ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

          type: 's',

          value: `${metric.value}  ${metric.label}`.trim(),

          styleIndex: styleMap.info,
        })),
      });

      sectionRow += 1;
    }

    const steps = sm.steps.slice(0, 12);

    if (steps.length > 0) {
      sheetRows.push({
        index: sectionRow,

        cells: steps.map((step, index) => ({
          ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

          type: 's',

          value: step.title,

          styleIndex: styleMap.header,
        })),
      });

      sectionRow += 1;

      if (steps.some((step) => step.description)) {
        sheetRows.push({
          index: sectionRow,

          cells: steps.map((step, index) => ({
            ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

            type: 's',

            value: step.description,

            styleIndex: styleMap.body,
          })),
        });

        sectionRow += 1;
      }
    }

    const columnBlocks = sm.columns.slice(0, 12);

    if (columnBlocks.length > 0) {
      if (columnBlocks.some((column) => column.title)) {
        sheetRows.push({
          index: sectionRow,

          cells: columnBlocks.map((column, index) => ({
            ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

            type: 's',

            value: column.title,

            styleIndex: styleMap.header,
          })),
        });

        sectionRow += 1;
      }

      const maxItems = Math.max(...columnBlocks.map((column) => column.items.length));

      for (let rowIndex = 0; rowIndex < maxItems; rowIndex += 1) {
        sheetRows.push({
          index: sectionRow,

          cells: columnBlocks.map((column, index) => ({
            ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

            type: 's',

            value: column.items[rowIndex] || '',

            styleIndex: styleMap.body,
          })),
        });

        sectionRow += 1;
      }
    }

    const sectionTables = [...sm.tables, ...(sm.table ? [sm.table] : [])];

    for (const table of sectionTables) {
      const cols = Array.isArray(table.columns)
        ? table.columns.map((value: any) => String(value))
        : [];

      const tableRows = Array.isArray(table.rows) ? table.rows : [];

      if (table.title) {
        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: String(table.title),

              styleIndex: styleMap.section,
            },
          ],
        });

        sectionRow += 1;
      }

      if (cols.length > 0) {
        sheetRows.push({
          index: sectionRow,

          cells: cols.map((label: string, index: number) => ({
            ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

            type: 's',

            value: label,

            styleIndex: styleMap.header,
          })),
        });

        sectionRow += 1;
      }

      tableRows.forEach((row: any, rowIndex: number) => {
        const values = Array.isArray(row) ? row : cols.map((column: string) => row?.[column] ?? '');

        sheetRows.push({
          index: sectionRow,

          cells: values.map((value: any, index: number) => ({
            ref: `${columnNumberToLetter(index + 1)}${sectionRow}`,

            type: 's',

            value: String(value ?? ''),

            styleIndex:
              layout.banded_rows === false
                ? styleMap.body
                : rowIndex % 2 === 0
                  ? styleMap.body
                  : styleMap.base,
          })),
        });

        sectionRow += 1;
      });
    }

    const checklist = sm.checklist;

    for (const item of checklist) {
      sheetRows.push({
        index: sectionRow,

        cells: [
          {
            ref: `A${sectionRow}`,

            type: 's',

            value: `${item.done ? '☑' : '☐'} ${item.text}`,

            styleIndex: item.done ? styleMap.success : styleMap.body,
          },
        ],
      });

      sectionMergeCells.push({ ref: `A${sectionRow}:${mergeSpanLetter}${sectionRow}` });

      sectionRow += 1;
    }

    if (sm.quote) {
      const quote = sm.quote;

      if (quote.text) {
        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: `「${quote.text}」${quote.attribution ? ` — ${quote.attribution}` : ''}`,

              styleIndex: styleMap.info,
            },
          ],
        });

        sectionRow += 1;
      }
    }

    if (sm.cta) {
      const ctaText = sm.cta;

      if (ctaText) {
        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: `→ ${ctaText}`,

              styleIndex: styleMap.info,
            },
          ],
        });

        sectionRow += 1;
      }
    }

    // wbs — indented hierarchy rows (tree glyph + level indent).

    if (sm.wbs.length > 0) {
      sm.wbs

        .slice(0, 60)

        .forEach((entry) => {
          const level = Math.min(entry.level, 4);

          sheetRows.push({
            index: sectionRow,

            cells: [
              {
                ref: `A${sectionRow}`,

                type: 's',

                value:
                  `${'  '.repeat(level - 1)}${level === 1 ? '■ ' : level === 2 ? '├ ' : '└ '}` +
                  entry.label,

                styleIndex: level === 1 ? styleMap.info : styleMap.body,
              },
            ],
          });

          sectionMergeCells.push({ ref: `A${sectionRow}:${mergeSpanLetter}${sectionRow}` });

          sectionRow += 1;
        });
    }

    // timeline — schedule rows: span | label | owner.

    sm.timeline

      .slice(0, 40)

      .forEach((entry: any) => {
        if (!entry || typeof entry !== 'object') return;
        if (!entry || typeof entry !== 'object') return;

        const label = entry.label;

        if (!label) return;

        const span = [entry.start, entry.end].filter(Boolean).join(' – ');

        const owner = entry.owner;

        sheetRows.push({
          index: sectionRow,

          cells: [
            { ref: `A${sectionRow}`, type: 's', value: span, styleIndex: styleMap.body },

            { ref: `B${sectionRow}`, type: 's', value: label, styleIndex: styleMap.body },

            { ref: `C${sectionRow}`, type: 's', value: owner, styleIndex: styleMap.body },
          ],
        });

        sectionRow += 1;
      });

    if (sm.timeline.length > 0) sectionRow += 1;

    // matrix — 2×2 quadrant cells (title + items joined per cell).

    const matrixRaw = sm.matrix;

    if (matrixRaw && matrixRaw.quadrants.length > 0) {
      const quadrants = matrixRaw.quadrants.slice(0, 4);

      for (let ri = 0; ri < quadrants.length; ri += 2) {
        const rowQuads = quadrants.slice(ri, ri + 2);

        sheetRows.push({
          index: sectionRow,

          cells: rowQuads.map((q: any, qi: number) => ({
            ref: `${columnNumberToLetter(qi + 1)}${sectionRow}`,

            type: 's',

            value:
              `${q?.title ? `■ ${q.title}` : ''}` +
              (Array.isArray(q?.items) && q.items.length
                ? `  ${q.items.map((i: any) => String(i ?? '')).join(' / ')}`
                : ''),

            styleIndex: styleMap.info,
          })),
        });

        sectionMergeCells.push({
          ref: `${columnNumberToLetter(1)}${sectionRow}:${columnNumberToLetter(2)}${sectionRow}`,
        });

        sectionRow += 1;
      }

      if (matrixRaw.xAxis) {
        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: matrixRaw.xAxis,

              styleIndex: styleMap.body,
            },
          ],
        });

        sectionMergeCells.push({ ref: `A${sectionRow}:${mergeSpanLetter}${sectionRow}` });

        sectionRow += 1;
      }
    }

    // process — ordered flow rows (STEP n / label / description).

    if (sm.process.length > 0) {
      sm.process.slice(0, 30).forEach((entry: any, i: number) => {
        const label = entry.label;
        if (!label) return;
        const description = entry.description;

        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: `STEP ${i + 1}`,

              styleIndex: styleMap.info,
            },

            {
              ref: `B${sectionRow}`,

              type: 's',

              value: label,

              styleIndex: styleMap.body,
            },

            ...(description
              ? [
                  {
                    ref: `C${sectionRow}`,
                    type: 's',
                    value: description,
                    styleIndex: styleMap.body,
                  },
                ]
              : []),
          ],
        });

        sectionRow += 1;
      });

      sectionRow += 1;
    }

    // org — hierarchy rows (level indent + role column).

    if (sm.org.length > 0) {
      const flat = sm.org;

      flat.slice(0, 40).forEach((member) => {
        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: `${'  '.repeat(Math.min(member.level, 4) - 1)}${member.level === 1 ? '◆ ' : '– '}${member.name}`,

              styleIndex: member.level === 1 ? styleMap.info : styleMap.body,
            },

            ...(member.role
              ? [
                  {
                    ref: `B${sectionRow}`,
                    type: 's',
                    value: member.role,
                    styleIndex: styleMap.body,
                  },
                ]
              : []),
          ],
        });

        sectionMergeCells.push({ ref: `A${sectionRow}:${mergeSpanLetter}${sectionRow}` });

        sectionRow += 1;
      });
    }

    // pyramid — ordered layers (apex first).

    if (sm.pyramid.length > 0) {
      sm.pyramid.slice(0, 8).forEach((entry: any, i: number) => {
        const label = entry.label;

        if (!label) return;

        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: `Lv.${i + 1}`,

              styleIndex: i === 0 ? styleMap.info : styleMap.body,
            },

            {
              ref: `B${sectionRow}`,

              type: 's',

              value: label + (entry.description ? ` — ${entry.description}` : ''),

              styleIndex: styleMap.body,
            },
          ],
        });

        sectionRow += 1;
      });

      sectionRow += 1;
    }

    // flow — swimlane rows: lane | joined steps.

    if (sm.flow.length > 0) {
      const lanes = sm.flow.map((l) => ({
        lane: l.lane,

        steps: l.steps.map((s) => s.label),
      }));

      lanes.forEach((lane) => {
        sheetRows.push({
          index: sectionRow,

          cells: [
            { ref: `A${sectionRow}`, type: 's', value: lane.lane, styleIndex: styleMap.info },

            {
              ref: `B${sectionRow}`,

              type: 's',

              value: lane.steps.join('  →  '),

              styleIndex: styleMap.body,
            },
          ],
        });

        sectionMergeCells.push({ ref: `B${sectionRow}:${mergeSpanLetter}${sectionRow}` });

        sectionRow += 1;
      });

      sectionRow += 1;
    }

    // roadmap — period | title | items rows.

    sm.roadmap.slice(0, 12).forEach((entry: any) => {
      const period = entry.period;

      const title = entry.title;

      const items = entry.items;

      if (!period && !title) return;

      sheetRows.push({
        index: sectionRow,

        cells: [
          { ref: `A${sectionRow}`, type: 's', value: period, styleIndex: styleMap.info },

          { ref: `B${sectionRow}`, type: 's', value: title, styleIndex: styleMap.body },

          ...(items.length
            ? [
                {
                  ref: `C${sectionRow}`,

                  type: 's',

                  value: items.join(' / '),

                  styleIndex: styleMap.body,
                },
              ]
            : []),
        ],
      });

      sectionRow += 1;
    });

    if (sm.roadmap.length > 0) sectionRow += 1;

    // kpi_table — metric | value | target | delta rows.

    if (sm.kpiTable.length > 0) {
      sheetRows.push({
        index: sectionRow,

        cells: [
          { ref: `A${sectionRow}`, type: 's', value: '指標', styleIndex: styleMap.header },

          { ref: `B${sectionRow}`, type: 's', value: '現在', styleIndex: styleMap.header },

          { ref: `C${sectionRow}`, type: 's', value: '目標', styleIndex: styleMap.header },

          { ref: `D${sectionRow}`, type: 's', value: '変化', styleIndex: styleMap.header },
        ],
      });

      sectionRow += 1;

      sm.kpiTable.slice(0, 12).forEach((entry: any) => {
        if (!entry || typeof entry !== 'object') return;

        sheetRows.push({
          index: sectionRow,

          cells: [
            {
              ref: `A${sectionRow}`,

              type: 's',

              value: entry.metric,

              styleIndex: styleMap.body,
            },

            {
              ref: `B${sectionRow}`,

              type: 's',

              value: entry.value,

              styleIndex: styleMap.info,
            },

            {
              ref: `C${sectionRow}`,

              type: 's',

              value: entry.target,

              styleIndex: styleMap.body,
            },

            {
              ref: `D${sectionRow}`,

              type: 's',

              value: entry.delta || entry.trend,

              styleIndex: styleMap.body,
            },
          ],
        });

        sectionRow += 1;
      });

      sectionRow += 1;
    }

    if (sm.image) {
      const spec = sm.image;

      const relPath = String(spec?.path ?? '');

      if (relPath) {
        try {
          const absoluteImage = assertSafeRepositoryPath(path.resolve(rootDir, relPath), {
            allowMissingLeaf: true,
          });

          if (
            safeExistsSync(absoluteImage) &&
            ['png', 'jpg', 'jpeg'].includes(path.extname(absoluteImage).slice(1).toLowerCase())
          ) {
            // Anchored image sized to the PNG's aspect ratio — row height

            // ≈15pt (0.208in) so span rows = heightIn / 0.208, capped.

            const dims = getPngDisplaySize(
              absoluteImage,

              Number(spec.height) || 1.8,

              Number(spec.width) || 4.2
            );

            const heightIn = dims.h > 0 ? dims.h : 1.8;

            const imageRowSpan = Math.min(
              24,

              Math.max(4, Number(spec.rows) || Math.ceil(heightIn / 0.208))
            );

            const imageColSpan = Math.min(12, Math.max(2, Number(spec.cols) || 4));

            drawingElements.push({
              type: 'image',

              name: String(spec.caption || `figure-${sectionRow}`),

              imagePath: absoluteImage,

              anchor: {
                type: 'twoCellAnchor',

                from: { col: 0, colOffset: 0, row: sectionRow - 1, rowOffset: 0 },

                to: {
                  col: imageColSpan,

                  colOffset: 0,

                  row: sectionRow - 1 + imageRowSpan,

                  rowOffset: 0,
                },
              },
            });

            sectionRow += imageRowSpan;

            if (spec.caption) {
              sheetRows.push({
                index: sectionRow,

                cells: [
                  {
                    ref: `A${sectionRow}`,

                    type: 's',

                    value: String(spec.caption),

                    styleIndex: styleMap.info,
                  },
                ],
              });

              sectionMergeCells.push({ ref: `A${sectionRow}:${mergeSpanLetter}${sectionRow}` });

              sectionRow += 1;
            }
          }
        } catch {
          // Out-of-repo image paths are dropped, same rule as elsewhere.
        }
      }
    }

    sectionRow += 1;
  }
}
