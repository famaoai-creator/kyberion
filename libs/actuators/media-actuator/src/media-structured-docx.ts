/** DOCX structured-content renderers — extracted from
 * `media-report-docx-builder.ts` (file-length policy). Appends
 * `bodyBlocks` entries for every populated field on the normalized
 * `StructuredSectionModel` (see `media-structured-content.ts`).
 */
import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { getPngDisplaySize } from './media-layout-catalog.js';
import type { StructuredSectionModel } from './media-structured-content.js';

export interface DocxStructuredCtx {
  /** Destination for emitted paragraph/table/drawing blocks. */
  bodyBlocks: any[];
  /** Image relationships appended by the image block. */
  imageRels: any[];
  /** Repo root for image path validation. */
  rootDir: string;
  /** Image counter — incremented per embedded figure (`rIdImg<N>`). */
  imageSeq: number;
  /** Theme token helpers (inches→twips, pt→half-points). */
  spTw: (key: string, fallbackInches: number) => number;
  halfPt: (key: string, fallbackPt: number) => number;
  /** Resolved theme colors. */
  accentHex: string;
  primaryHex: string;
  surfaceHex: string;
  borderHex: string;
  mutedHex: string;
  textHex: string;
}

/**
 * Emit the structured-content blocks for one section. `sm` is the normalized
 * model for `section`; callers pass `sm` so the same section isn't normalized
 * twice (heading/body paths read `section` directly).
 */
export function appendStructuredDocxBlocks(
  sm: StructuredSectionModel,
  ctx: DocxStructuredCtx
): void {
  const {
    bodyBlocks,
    imageRels,
    rootDir,
    spTw,
    halfPt,
    accentHex,
    primaryHex,
    surfaceHex,
    borderHex,
    mutedHex,
    textHex,
  } = ctx;
  // ── Structured components — same typed fields as the slide path ───────
  // Tables give DOCX what cards/shapes give PPTX: a metrics band is a
  // surface-filled row, a roadmap is a two-row phase table, a comparison
  // is a multi-column row. All sizes flow from theme tokens via spTw /
  // halfPt so a theme carrying `spacing`/`typography` retunes the whole
  // document the same way it retunes a deck.
  const metrics = sm.metrics.slice(0, 6);
  if (metrics.length > 0) {
    const cellW = Math.floor(7500 / metrics.length);
    bodyBlocks.push({
      type: 'table',
      table: {
        tblPr: {
          tblW: { w: 5000, type: 'pct' },
          tblBorders: {
            // White inside separators read as gaps between cards —
            // surface-filled cells would collide with a visible rule.
            top: { val: 'single', sz: 4, color: borderHex },
            left: { val: 'single', sz: 4, color: borderHex },
            bottom: { val: 'single', sz: 4, color: borderHex },
            right: { val: 'single', sz: 4, color: borderHex },
            insideV: { val: 'single', sz: 12, color: 'FFFFFF' },
          },
          tblCellMar: {
            top: spTw('sm', 0.12),
            left: spTw('md', 0.15),
            bottom: spTw('sm', 0.12),
            right: spTw('md', 0.15),
          },
        },
        tblGrid: metrics.map(() => cellW),
        rows: [
          {
            trPr: { cantSplit: true },
            cells: metrics.map((metric) => ({
              tcPr: {
                tcW: { w: cellW, type: 'dxa' },
                shd: { val: 'clear', fill: surfaceHex },
                vAlign: 'center',
              },
              content: [
                {
                  type: 'paragraph',
                  paragraph: {
                    content: [
                      {
                        type: 'run',
                        run: {
                          rPr: {
                            bold: true,
                            sz: halfPt('headline', 20),
                            color: { val: primaryHex },
                          },
                          content: [{ type: 'text', text: metric.value }],
                        },
                      },
                    ],
                  },
                },
                ...(metric.label
                  ? [
                      {
                        type: 'paragraph',
                        paragraph: {
                          content: [
                            {
                              type: 'run',
                              run: {
                                rPr: { sz: halfPt('label', 10), color: { val: mutedHex } },
                                content: [{ type: 'text', text: metric.label }],
                              },
                            },
                          ],
                        },
                      },
                    ]
                  : []),
              ],
            })),
          },
        ],
      },
    });
  }

  const steps = sm.steps.slice(0, 6);
  if (steps.length > 0) {
    const cellW = Math.floor(7500 / steps.length);
    bodyBlocks.push({
      type: 'table',
      table: {
        tblPr: {
          tblW: { w: 5000, type: 'pct' },
          tblCellMar: {
            top: spTw('xs', 0.08),
            left: spTw('sm', 0.12),
            bottom: spTw('xs', 0.08),
            right: spTw('sm', 0.12),
          },
        },
        tblGrid: steps.map(() => cellW),
        rows: [
          {
            trPr: { cantSplit: true },
            cells: steps.map((step, stepIndex) => ({
              tcPr: {
                tcW: { w: cellW, type: 'dxa' },
                shd: {
                  val: 'clear',
                  fill: stepIndex === steps.length - 1 ? accentHex : primaryHex,
                },
                vAlign: 'center',
              },
              content: [
                {
                  type: 'paragraph',
                  paragraph: {
                    pPr: { jc: 'center' },
                    content: [
                      {
                        type: 'run',
                        run: {
                          rPr: { bold: true, sz: halfPt('label', 11), color: { val: 'FFFFFF' } },
                          content: [{ type: 'text', text: step.title }],
                        },
                      },
                    ],
                  },
                },
              ],
            })),
          },
          ...(steps.some((step) => step.description)
            ? [
                {
                  trPr: { cantSplit: true },
                  cells: steps.map((step) => ({
                    tcPr: {
                      tcW: { w: cellW, type: 'dxa' },
                      shd: { val: 'clear', fill: surfaceHex },
                    },
                    content: [
                      {
                        type: 'paragraph',
                        paragraph: {
                          content: [
                            {
                              type: 'run',
                              run: {
                                rPr: { sz: halfPt('caption', 9.5), color: { val: mutedHex } },
                                content: [{ type: 'text', text: step.description }],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  })),
                },
              ]
            : []),
        ],
      },
    });
  }

  const columnBlocks = sm.columns.slice(0, 3);
  if (columnBlocks.length > 0) {
    const cellW = Math.floor(7500 / columnBlocks.length);
    bodyBlocks.push({
      type: 'table',
      table: {
        tblPr: {
          tblW: { w: 5000, type: 'pct' },
          tblCellMar: {
            top: spTw('sm', 0.12),
            left: spTw('md', 0.15),
            bottom: spTw('sm', 0.12),
            right: spTw('md', 0.15),
          },
          tblBorders: {
            top: { val: 'single', sz: 4, color: borderHex },
            left: { val: 'single', sz: 4, color: borderHex },
            bottom: { val: 'single', sz: 4, color: borderHex },
            right: { val: 'single', sz: 4, color: borderHex },
            insideV: { val: 'single', sz: 12, color: 'FFFFFF' },
          },
        },
        tblGrid: columnBlocks.map(() => cellW),
        rows: [
          {
            trPr: { cantSplit: true },
            cells: columnBlocks.map((column) => ({
              tcPr: {
                tcW: { w: cellW, type: 'dxa' },
                shd: { val: 'clear', fill: surfaceHex },
              },
              content: [
                ...(column.title
                  ? [
                      {
                        type: 'paragraph',
                        paragraph: {
                          pPr: { spacing: { after: spTw('xs', 0.08) } },
                          content: [
                            {
                              type: 'run',
                              run: {
                                rPr: {
                                  bold: true,
                                  sz: halfPt('label', 11),
                                  color: { val: accentHex },
                                },
                                content: [{ type: 'text', text: column.title }],
                              },
                            },
                          ],
                        },
                      },
                    ]
                  : []),
                ...column.items.map((item: string) => ({
                  type: 'paragraph',
                  paragraph: {
                    pPr: { spacing: { after: spTw('xxs', 0.04) } },
                    content: [
                      {
                        type: 'run',
                        run: {
                          rPr: { sz: halfPt('body', 10.5), color: { val: textHex } },
                          content: [{ type: 'text', text: `• ${item}` }],
                        },
                      },
                    ],
                  },
                })),
              ],
            })),
          },
        ],
      },
    });
  }

  const checklist = sm.checklist;
  for (const item of checklist) {
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: {
          spacing: { after: spTw('xs', 0.06) },
          ind: { left: spTw('lg', 0.25) },
        },
        content: [
          {
            type: 'run',
            run: {
              rPr: { sz: halfPt('body', 10.5), color: { val: textHex } },
              content: [{ type: 'text', text: `${item.done ? '☑' : '☐'} ${item.text}` }],
            },
          },
        ],
      },
    });
  }

  if (sm.quote) {
    const quote = sm.quote;
    if (quote.text) {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: {
            spacing: { before: spTw('md', 0.15), after: spTw('xs', 0.08) },
            ind: { left: spTw('xl', 0.33) },
            pBdr: { left: { val: 'single', sz: 18, space: 8, color: accentHex } },
          },
          content: [
            {
              type: 'run',
              run: {
                rPr: { bold: true, sz: halfPt('subtitle', 15), color: { val: textHex } },
                content: [{ type: 'text', text: `「${quote.text}」` }],
              },
            },
          ],
        },
      });
      if (quote.attribution) {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
            pPr: {
              spacing: { after: spTw('md', 0.15) },
              ind: { left: spTw('xl', 0.33) },
            },
            content: [
              {
                type: 'run',
                run: {
                  rPr: { sz: halfPt('caption', 9.5), color: { val: mutedHex } },
                  content: [{ type: 'text', text: `— ${quote.attribution}` }],
                },
              },
            ],
          },
        });
      }
    }
  }

  if (sm.cta) {
    const ctaText = sm.cta;
    if (ctaText) {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: {
            spacing: { before: spTw('md', 0.15), after: spTw('md', 0.15) },
            ind: { left: spTw('sm', 0.12), right: spTw('sm', 0.12) },
            shd: { val: 'clear', fill: accentHex },
            pBdr: {
              top: { val: 'single', sz: 4, space: 6, color: accentHex },
              bottom: { val: 'single', sz: 4, space: 6, color: accentHex },
              left: { val: 'single', sz: 4, space: 6, color: accentHex },
              right: { val: 'single', sz: 4, space: 6, color: accentHex },
            },
          },
          content: [
            {
              type: 'run',
              run: {
                rPr: {
                  bold: true,
                  sz: halfPt('subtitle', 13),
                  color: { val: 'FFFFFF' },
                },
                content: [{ type: 'text', text: `→ ${ctaText}` }],
              },
            },
          ],
        },
      });
    }
  }

  // wbs — hierarchical work breakdown: L1 bold with accent bar,
  // deeper levels indented with tree connectors.
  if (sm.wbs.length > 0) {
    sm.wbs.slice(0, 40).forEach((entry) => {
      const level = Math.min(entry.level, 4);
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: {
            ind: {
              left: spTw('md', 0.15) + (level - 1) * spTw('lg', 0.28),
            },
            spacing: { before: 0, after: spTw('xxs', 0.04) },
          },
          content: [
            {
              type: 'run',
              run: {
                rPr: {
                  bold: level === 1 || undefined,
                  color: { val: level === 1 ? primaryHex : textHex },
                  sz: halfPt(level === 1 ? 'title' : 'body', level === 1 ? 10.5 : 10),
                },
                content: [
                  {
                    type: 'text',
                    text: (level === 1 ? '■ ' : level === 2 ? '├ ' : '└ ') + entry.label,
                  },
                ],
              },
            },
          ],
        },
      });
    });
  }

  // timeline — date-ranged entries render as a schedule table
  // (期間/項目/担当); docx can't draw proportional bars inline.
  if (sm.timeline.length > 0) {
    const entries = sm.timeline.map((e) => ({
      label: e.label,
      span: [e.start, e.end].filter(Boolean).join(' – '),
      owner: e.owner,
    }));
    if (entries.length > 0) {
      const colWidthsTw = [2400, 3900, 1200];
      bodyBlocks.push({
        type: 'table',
        table: {
          tblPr: {
            tblStyle: 'TableGrid',
            tblW: { w: 7500, type: 'dxa' },
            tblBorders: {
              top: { val: 'single', sz: 4, color: borderHex },
              left: { val: 'single', sz: 4, color: borderHex },
              bottom: { val: 'single', sz: 4, color: borderHex },
              right: { val: 'single', sz: 4, color: borderHex },
              insideH: { val: 'single', sz: 4, color: borderHex },
              insideV: { val: 'single', sz: 4, color: borderHex },
            },
            tblCellMar: {
              top: spTw('xxs', 0.05),
              left: spTw('xs', 0.08),
              bottom: spTw('xxs', 0.05),
              right: spTw('xs', 0.08),
            },
          },
          tblGrid: colWidthsTw,
          rows: [
            {
              trPr: { tblHeader: true },
              cells: ['期間', '項目', '担当'].map((label: string, i: number) => ({
                tcPr: {
                  tcW: { w: colWidthsTw[i], type: 'dxa' },
                  shd: { val: 'clear', fill: primaryHex },
                },
                content: [
                  {
                    type: 'paragraph',
                    paragraph: {
                      content: [
                        {
                          type: 'run',
                          run: {
                            rPr: { bold: true, color: { val: 'FFFFFF' }, sz: halfPt('label', 10) },
                            content: [{ type: 'text', text: label }],
                          },
                        },
                      ],
                    },
                  },
                ],
              })),
            },
            ...entries.map((entry: any) => ({
              trPr: { cantSplit: true },
              cells: [entry.span, entry.label, entry.owner].map((value: string, i: number) => ({
                tcPr: { tcW: { w: colWidthsTw[i], type: 'dxa' } },
                content: [
                  {
                    type: 'paragraph',
                    paragraph: {
                      content: [
                        {
                          type: 'run',
                          run: {
                            rPr: { sz: halfPt('body', 10) },
                            content: [{ type: 'text', text: value }],
                          },
                        },
                      ],
                    },
                  },
                ],
              })),
            })),
          ],
        },
      });
    }
  }

  // matrix — 2×2 quadrant grid rendered as a styled table.
  const matrixRaw = sm.matrix;
  if (matrixRaw && matrixRaw.quadrants.length > 0) {
    const quadrants = matrixRaw.quadrants.slice(0, 4);
    const cellW = Math.floor(7500 / Math.max(Math.ceil(quadrants.length / 2), 1));
    const matCell = (q: any) => ({
      tcPr: {
        tcW: { w: cellW, type: 'dxa' },
        shd: { val: 'clear', fill: surfaceHex },
      },
      content: [
        {
          type: 'paragraph',
          paragraph: {
            content: [
              {
                type: 'run',
                run: {
                  rPr: { bold: true, color: { val: primaryHex }, sz: halfPt('label', 10.5) },
                  content: [{ type: 'text', text: String(q?.title ?? '') }],
                },
              },
            ],
          },
        },
        ...(Array.isArray(q?.items)
          ? q.items.map((item: any) => ({
              type: 'paragraph',
              paragraph: {
                pPr: { ind: { left: spTw('xs', 0.1) }, spacing: { before: 0, after: 0 } },
                content: [
                  {
                    type: 'run',
                    run: {
                      rPr: { sz: halfPt('body', 9.5) },
                      content: [{ type: 'text', text: `• ${String(item ?? '')}` }],
                    },
                  },
                ],
              },
            }))
          : []),
      ],
    });
    const matRows: any[] = [];
    for (let i = 0; i < quadrants.length; i += 2) {
      matRows.push({ trPr: { cantSplit: true }, cells: quadrants.slice(i, i + 2).map(matCell) });
    }
    bodyBlocks.push({
      type: 'table',
      table: {
        tblPr: {
          tblW: { w: 7500, type: 'dxa' },
          tblBorders: {
            top: { val: 'single', sz: 4, color: borderHex },
            left: { val: 'single', sz: 4, color: borderHex },
            bottom: { val: 'single', sz: 4, color: borderHex },
            right: { val: 'single', sz: 4, color: borderHex },
            insideH: { val: 'single', sz: 12, color: 'FFFFFF' },
            insideV: { val: 'single', sz: 12, color: 'FFFFFF' },
          },
          tblCellMar: {
            top: spTw('sm', 0.1),
            left: spTw('md', 0.15),
            bottom: spTw('sm', 0.1),
            right: spTw('md', 0.15),
          },
        },
        tblGrid: quadrants.length > 1 ? [cellW, cellW] : [cellW],
        rows: matRows,
      },
    });
    if (matrixRaw.xAxis) {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: { jc: 'center', spacing: { before: spTw('xxs', 0.05), after: spTw('sm', 0.1) } },
          content: [
            {
              type: 'run',
              run: {
                rPr: { sz: halfPt('caption', 9.5), color: { val: mutedHex } },
                content: [{ type: 'text', text: matrixRaw.xAxis }],
              },
            },
          ],
        },
      });
    }
  }

  // process — ordered flow steps with arrow separators.
  if (sm.process.length > 0) {
    sm.process.slice(0, 20).forEach((step: any, i: number) => {
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: {
            ind: { left: spTw('md', 0.15) },
            spacing: { before: spTw('xxs', 0.03), after: 0 },
          },
          content: [
            {
              type: 'run',
              run: {
                rPr: {
                  bold: true,
                  color: { val: i === 0 ? accentHex : primaryHex },
                  sz: halfPt('body', 10.5),
                },
                content: [
                  {
                    type: 'text',
                    text: `${i + 1}. ${step.label}${step.description ? ` — ${step.description}` : ''}`,
                  },
                ],
              },
            },
          ],
        },
      });
      if (i < sm.process.length - 1) {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
            pPr: {
              ind: { left: spTw('md', 0.15) + spTw('md', 0.16) },
              spacing: { before: 0, after: 0 },
            },
            content: [
              {
                type: 'run',
                run: {
                  rPr: { color: { val: mutedHex }, sz: halfPt('body', 10) },
                  content: [{ type: 'text', text: '↓' }],
                },
              },
            ],
          },
        });
      }
    });
  }

  // org — hierarchy rendered like the WBS (level indent, role suffix).
  if (sm.org.length > 0) {
    sm.org.slice(0, 30).forEach((member) => {
      const level = Math.min(member.level, 4);
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: {
            ind: { left: spTw('md', 0.15) + (level - 1) * spTw('lg', 0.3) },
            spacing: { before: 0, after: spTw('xxs', 0.04) },
          },
          content: [
            {
              type: 'run',
              run: {
                rPr: {
                  bold: level === 1 || undefined,
                  color: { val: level === 1 ? primaryHex : textHex },
                  sz: halfPt('body', 10),
                },
                content: [
                  {
                    type: 'text',
                    text:
                      (level === 1 ? '◆ ' : '– ') +
                      member.name +
                      (member.role ? `（${member.role}）` : ''),
                  },
                ],
              },
            },
          ],
        },
      });
    });
  }

  // pyramid — decreasing indent layers read as a visual hierarchy.
  if (sm.pyramid.length > 0) {
    const layers = sm.pyramid;
    const n = layers.length;
    layers.forEach((layer, i) => {
      const indentTw = Math.round(((n - 1 - i) / Math.max(n - 1, 1)) * 2400);
      const isApex = i === 0;
      const isBase = i === n - 1;
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: {
          pPr: {
            jc: 'center',
            ind: { left: indentTw, right: indentTw },
            shd: {
              val: 'clear',
              fill: isApex ? primaryHex : isBase ? accentHex : surfaceHex,
            },
            spacing: { before: 0, after: spTw('xxs', 0.03) },
          },
          content: [
            {
              type: 'run',
              run: {
                rPr: {
                  bold: isApex || isBase,
                  color: { val: isApex || isBase ? 'FFFFFF' : textHex },
                  sz: halfPt('body', 10),
                },
                content: [
                  {
                    type: 'text',
                    text: layer.label + (layer.description ? ` — ${layer.description}` : ''),
                  },
                ],
              },
            },
          ],
        },
      });
    });
  }

  // flow — swimlane: one row per lane, steps joined by arrows.
  if (sm.flow.length > 0) {
    const lanes = sm.flow.slice(0, 8).map((l) => ({
      lane: l.lane,
      steps: l.steps.map((s) => s.label),
    }));
    const laneW = 1500;
    const laneStepW = Math.floor((7500 - laneW) / 1);
    lanes.forEach((lane, i) => {
      bodyBlocks.push({
        type: 'table',
        table: {
          tblPr: {
            tblW: { w: 7500, type: 'dxa' },
            tblBorders: {
              top: { val: 'single', sz: 4, color: borderHex },
              left: { val: 'single', sz: 4, color: borderHex },
              bottom: { val: 'single', sz: 4, color: borderHex },
              right: { val: 'single', sz: 4, color: borderHex },
              insideV: { val: 'single', sz: 4, color: borderHex },
            },
            tblCellMar: {
              top: spTw('xxs', 0.06),
              left: spTw('xs', 0.08),
              bottom: spTw('xxs', 0.06),
              right: spTw('xs', 0.08),
            },
          },
          tblGrid: [laneW, laneStepW],
          rows: [
            {
              trPr: { cantSplit: true },
              cells: [
                {
                  tcPr: { tcW: { w: laneW, type: 'dxa' }, shd: { val: 'clear', fill: primaryHex } },
                  content: [
                    {
                      type: 'paragraph',
                      paragraph: {
                        content: [
                          {
                            type: 'run',
                            run: {
                              rPr: {
                                bold: true,
                                color: { val: 'FFFFFF' },
                                sz: halfPt('label', 10),
                              },
                              content: [{ type: 'text', text: lane.lane || `Lane ${i + 1}` }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  tcPr: {
                    tcW: { w: laneStepW, type: 'dxa' },
                    shd: { val: 'clear', fill: surfaceHex },
                  },
                  content: [
                    {
                      type: 'paragraph',
                      paragraph: {
                        content: [
                          {
                            type: 'run',
                            run: {
                              rPr: { sz: halfPt('body', 10) },
                              content: [{ type: 'text', text: lane.steps.join('  →  ') }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      bodyBlocks.push({
        type: 'paragraph',
        paragraph: { pPr: { spacing: { before: 0, after: spTw('xxs', 0.04) } }, content: [] },
      });
    });
  }

  // roadmap — period cards as a side-by-side columns table.
  if (sm.roadmap.length > 0) {
    const periods = sm.roadmap.slice(0, 5);
    if (periods.length > 0) {
      const periodCellW = Math.floor(7500 / periods.length);
      bodyBlocks.push({
        type: 'table',
        table: {
          tblPr: {
            tblW: { w: 7500, type: 'dxa' },
            tblBorders: {
              top: { val: 'single', sz: 4, color: borderHex },
              left: { val: 'single', sz: 4, color: borderHex },
              bottom: { val: 'single', sz: 4, color: borderHex },
              right: { val: 'single', sz: 4, color: borderHex },
              insideH: { val: 'single', sz: 12, color: 'FFFFFF' },
              insideV: { val: 'single', sz: 12, color: 'FFFFFF' },
            },
            tblCellMar: {
              top: spTw('sm', 0.1),
              left: spTw('md', 0.15),
              bottom: spTw('sm', 0.1),
              right: spTw('md', 0.15),
            },
          },
          tblGrid: periods.map(() => periodCellW),
          rows: [
            {
              trPr: { tblHeader: true, cantSplit: true },
              cells: periods.map((period, i) => ({
                tcPr: {
                  tcW: { w: periodCellW, type: 'dxa' },
                  shd: {
                    val: 'clear',
                    fill: i === periods.length - 1 ? accentHex : primaryHex,
                  },
                },
                content: [
                  {
                    type: 'paragraph',
                    paragraph: {
                      pPr: { jc: 'center' },
                      content: [
                        {
                          type: 'run',
                          run: {
                            rPr: { bold: true, color: { val: 'FFFFFF' }, sz: halfPt('label', 10) },
                            content: [{ type: 'text', text: period.period || period.title }],
                          },
                        },
                      ],
                    },
                  },
                ],
              })),
            },
            {
              trPr: { cantSplit: true },
              cells: periods.map((period) => ({
                tcPr: {
                  tcW: { w: periodCellW, type: 'dxa' },
                  shd: { val: 'clear', fill: surfaceHex },
                },
                content: [
                  ...(period.title && period.period
                    ? [
                        {
                          type: 'paragraph',
                          paragraph: {
                            content: [
                              {
                                type: 'run',
                                run: {
                                  rPr: {
                                    bold: true,
                                    color: { val: primaryHex },
                                    sz: halfPt('label', 10),
                                  },
                                  content: [{ type: 'text', text: period.title }],
                                },
                              },
                            ],
                          },
                        },
                      ]
                    : []),
                  ...period.items.map((item: string) => ({
                    type: 'paragraph',
                    paragraph: {
                      pPr: { spacing: { before: 0, after: 0 } },
                      content: [
                        {
                          type: 'run',
                          run: {
                            rPr: { sz: halfPt('body', 9.5) },
                            content: [{ type: 'text', text: `• ${item}` }],
                          },
                        },
                      ],
                    },
                  })),
                ],
              })),
            },
          ],
        },
      });
    }
  }

  // kpi_table — metric / value / target / delta columns.
  if (sm.kpiTable.length > 0) {
    const kpis = sm.kpiTable
      .map((k) => ({
        metric: k.metric,
        value: k.value,
        target: k.target,
        delta: k.delta || k.trend,
      }))
      .slice(0, 12);
    if (kpis.length > 0) {
      const kpiCols = [3000, 1800, 1400, 1300];
      bodyBlocks.push({
        type: 'table',
        table: {
          tblPr: {
            tblStyle: 'TableGrid',
            tblW: { w: 7500, type: 'dxa' },
            tblBorders: {
              top: { val: 'single', sz: 4, color: borderHex },
              left: { val: 'single', sz: 4, color: borderHex },
              bottom: { val: 'single', sz: 4, color: borderHex },
              right: { val: 'single', sz: 4, color: borderHex },
              insideH: { val: 'single', sz: 4, color: borderHex },
              insideV: { val: 'single', sz: 4, color: borderHex },
            },
            tblCellMar: {
              top: spTw('xxs', 0.05),
              left: spTw('xs', 0.08),
              bottom: spTw('xxs', 0.05),
              right: spTw('xs', 0.08),
            },
          },
          tblGrid: kpiCols,
          rows: [
            {
              trPr: { tblHeader: true },
              cells: ['指標', '現在', '目標', '変化'].map((label: string, i: number) => ({
                tcPr: {
                  tcW: { w: kpiCols[i], type: 'dxa' },
                  shd: { val: 'clear', fill: primaryHex },
                },
                content: [
                  {
                    type: 'paragraph',
                    paragraph: {
                      content: [
                        {
                          type: 'run',
                          run: {
                            rPr: { bold: true, color: { val: 'FFFFFF' }, sz: halfPt('label', 10) },
                            content: [{ type: 'text', text: label }],
                          },
                        },
                      ],
                    },
                  },
                ],
              })),
            },
            ...kpis.map((kpi: any) => ({
              trPr: { cantSplit: true },
              cells: [
                {
                  tcPr: { tcW: { w: kpiCols[0], type: 'dxa' } },
                  content: [
                    {
                      type: 'paragraph',
                      paragraph: {
                        content: [
                          {
                            type: 'run',
                            run: {
                              rPr: { sz: halfPt('body', 10) },
                              content: [{ type: 'text', text: kpi.metric }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  tcPr: { tcW: { w: kpiCols[1], type: 'dxa' } },
                  content: [
                    {
                      type: 'paragraph',
                      paragraph: {
                        content: [
                          {
                            type: 'run',
                            run: {
                              rPr: {
                                bold: true,
                                color: { val: primaryHex },
                                sz: halfPt('label', 10.5),
                              },
                              content: [{ type: 'text', text: kpi.value }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  tcPr: { tcW: { w: kpiCols[2], type: 'dxa' } },
                  content: [
                    {
                      type: 'paragraph',
                      paragraph: {
                        content: [
                          {
                            type: 'run',
                            run: {
                              rPr: { sz: halfPt('body', 10), color: { val: mutedHex } },
                              content: [{ type: 'text', text: kpi.target }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  tcPr: { tcW: { w: kpiCols[3], type: 'dxa' } },
                  content: [
                    {
                      type: 'paragraph',
                      paragraph: {
                        content: [
                          {
                            type: 'run',
                            run: {
                              rPr: {
                                bold: true,
                                color: {
                                  val: /^[+↑▲]/.test(kpi.delta) ? accentHex : mutedHex,
                                },
                                sz: halfPt('body', 10),
                              },
                              content: [{ type: 'text', text: kpi.delta }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            })),
          ],
        },
      });
    }
  }

  if (sm.image) {
    const spec = sm.image;
    const relPath = String(spec?.path ?? '');
    if (relPath) {
      try {
        const absoluteImage = assertSafeRepositoryPath(path.resolve(rootDir, relPath), {
          allowMissingLeaf: true,
        });
        if (safeExistsSync(absoluteImage)) {
          const display = getPngDisplaySize(
            absoluteImage,
            Number(spec.height) || 2.6,
            Number(spec.width) || 6.2
          );
          const wIn = display.w > 0 ? display.w : 4.5;
          const hIn = display.h > 0 ? display.h : 2.6;
          const imageAlign =
            spec.align === 'left' ? 'left' : spec.align === 'right' ? 'right' : 'center';
          const rawExt = path.extname(absoluteImage).slice(1).toLowerCase();
          const ext = rawExt === 'jpg' ? 'jpeg' : rawExt;
          // Content-types declares png/jpeg/gif/bmp/tiff — anything else
          // would produce an undeclared media part (repair prompt).
          if (!['png', 'jpeg', 'gif', 'bmp', 'tiff'].includes(ext)) return;
          const rid = `rIdImg${++ctx.imageSeq}`;
          imageRels.push({
            id: rid,
            type: 'image',
            target: `media/report-figure-${ctx.imageSeq}.${ext}`,
          });
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { jc: imageAlign, spacing: { before: spTw('sm', 0.12), after: 0 } },
              content: [
                {
                  type: 'run',
                  run: {
                    content: [
                      {
                        type: 'drawing',
                        drawing: {
                          type: 'inline',
                          imageRId: rid,
                          imagePath: absoluteImage,
                          name: String(spec.caption || 'Figure'),
                          description: String(spec.caption || ''),
                          extent: {
                            cx: Math.round(wIn * 914400),
                            cy: Math.round(hIn * 914400),
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          });
          if (spec.caption) {
            bodyBlocks.push({
              type: 'paragraph',
              paragraph: {
                pPr: { jc: 'center', spacing: { after: spTw('sm', 0.12) } },
                content: [
                  {
                    type: 'run',
                    run: {
                      rPr: { sz: halfPt('caption', 9.5), color: { val: mutedHex } },
                      content: [{ type: 'text', text: String(spec.caption) }],
                    },
                  },
                ],
              },
            });
          }
        }
      } catch {
        // Out-of-repo image paths are dropped, same rule as slide logos.
      }
    }
  }
}
