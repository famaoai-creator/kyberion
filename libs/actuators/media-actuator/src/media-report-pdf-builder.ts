import { resolveDocumentContentsLabel } from '@agent/core/document-contents-policy';
import { resolveReportSectionTitle } from '@agent/core/document-outline-label-policy';
import { nowIso } from '@agent/core/foundation';
import { measureTextWidthPt, wrapLine } from '@agent/core/native-pptx-engine/text-metrics';
import { normalizeStructuredSection } from './media-structured-content.js';
import { appendStructuredPdfBlocks } from './media-structured-pdf.js';
import {
  buildMediaGenerationBoundary,
  buildReportNarrativeOutline,
  classifyRenderSemantic,
} from './media-document-helpers.js';
import {
  hexToPdfRgb,
  type MediaReportPdfProtocol,
  type MediaReportPipelineDeps,
} from './media-report-shared.js';

/** Builds the PDF design protocol for a summary-report brief. */
export function buildReportPdfProtocol(
  deps: MediaReportPipelineDeps,
  rootDir: string,
  brief: any
): MediaReportPdfProtocol {
  const outline = buildReportNarrativeOutline(
    rootDir,
    brief,
    deps.resolveDocumentCompositionPreset,
    (template, tokens, fallback = '') => {
      if (template === undefined || template === null) return fallback;
      return (
        String(template)
          .replace(/\{\{([^}]+)\}\}/g, (_match, key) =>
            String(tokens?.[String(key).trim()] || fallback || '')
          )
          .trim() || fallback
      );
    }
  );
  const { preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
  const { template, templateId } = deps.resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'report',
    layout_template_id: brief.layout_template_id,
  });
  const activeTheme = deps.resolveNamedTheme(rootDir, preset?.recommended_theme);
  const pdfLayout = template?.pdf || {};
  const tableStyle = pdfLayout.table || {};
  const tableWidth = Number(tableStyle.width || 490);
  const headerFill = hexToPdfRgb(
    tableStyle.header_fill,
    hexToPdfRgb(activeTheme?.colors?.primary, [0.12, 0.16, 0.22])
  );
  const gridStroke = hexToPdfRgb(tableStyle.grid_stroke, [0.8, 0.84, 0.89]);
  const outerStroke = hexToPdfRgb(tableStyle.outer_stroke, [0.58, 0.64, 0.72]);
  const zebraFill = hexToPdfRgb(tableStyle.zebra_fill, [0.97, 0.98, 0.99]);
  const showZebra = tableStyle.show_zebra !== false;
  const accentFill = hexToPdfRgb(activeTheme?.colors?.accent, [0.93, 0.96, 1.0]);
  const themePrimary = String(
    activeTheme?.colors?.primary || template?.colors?.primary || '#1f2937'
  );
  const themeSecondary = String(
    activeTheme?.colors?.secondary || template?.colors?.secondary || '#4b5563'
  );
  const themeAccent = String(activeTheme?.colors?.accent || template?.colors?.accent || '#2563eb');
  const themeBackground = String(activeTheme?.colors?.background || '#ffffff');
  const reportSectionTitle = resolveReportSectionTitle();
  const vectors: any[] = [];
  const contentsEntry = Array.isArray(outline.toc)
    ? outline.toc.find((entry: any) => String(entry.section_id) === 'contents')
    : null;
  const bodySections = (() => {
    const sections = Array.isArray(brief.payload.sections) ? brief.payload.sections : [];
    const bodySectionOrder =
      Array.isArray(template?.body_sections) && template.body_sections.length > 0
        ? template.body_sections.map((value: any) => String(value))
        : ['title', 'summary', 'contents', 'section', 'callout', 'bullet', 'table'];
    const collected: string[] = [];
    const pushValue = (value: unknown) => {
      if (value === undefined || value === null) return;
      const text = String(value).trim();
      if (text) collected.push(text);
    };

    for (const entry of bodySectionOrder) {
      if (entry === 'title') {
        pushValue(brief.title || brief.payload?.title || 'Report');
        continue;
      }
      if (entry === 'summary') {
        pushValue(brief.payload.summary || '');
        continue;
      }
      if (entry === 'contents') {
        if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
          pushValue(contentsEntry.title || resolveDocumentContentsLabel(brief.locale));
          contentsEntry.body.forEach(pushValue);
        }
        continue;
      }
      if (entry === 'section') {
        for (const section of sections) {
          pushValue(section.heading || reportSectionTitle);
          if (Array.isArray(section.body)) section.body.forEach(pushValue);
        }
        continue;
      }
      if (entry === 'callout') {
        for (const section of sections) {
          if (Array.isArray(section.callouts)) {
            for (const callout of section.callouts) {
              pushValue(
                callout.title
                  ? [callout.title, callout.tone ? `(${callout.tone})` : '']
                      .filter(Boolean)
                      .join(' ')
                  : ''
              );
              pushValue(callout.body || '');
            }
          }
        }
        continue;
      }
      if (entry === 'bullet') {
        for (const section of sections) {
          if (Array.isArray(section.bullets)) {
            section.bullets.forEach((item: string) => pushValue(`- ${item}`));
          }
        }
        continue;
      }
      if (entry === 'table') {
        for (const section of sections) {
          if (Array.isArray(section.tables)) {
            for (const table of section.tables) {
              pushValue(table.title || '');
              const columns = Array.isArray(table.columns) ? table.columns : [];
              const rows = Array.isArray(table.rows) ? table.rows : [];
              if (columns.length > 0) {
                pushValue(columns.join(' | '));
                rows.forEach((row: any) => {
                  const values = Array.isArray(row)
                    ? row
                    : columns.map((column: string) => row?.[column] ?? '');
                  pushValue(values.map((value: any) => String(value ?? '')).join(' | '));
                });
              }
            }
          }
        }
      }
    }

    return collected;
  })();

  const titleX = pdfLayout.title_x || pdfLayout.margin_left || 48;
  const titleY = pdfLayout.title_y || 42;
  const elements: any[] = [
    // Eyebrow — small accent kicker above the document title.
    {
      type: 'text',
      x: titleX,
      y: titleY - 14,
      text: String(brief.document_profile || 'summary-report')
        .replace(/-/g, ' ')
        .toUpperCase(),
      fontSize: 9,
      color: accentFill,
    },
    {
      type: 'text',
      x: titleX,
      y: titleY,
      text: brief.title || brief.payload?.title || 'Report',
      fontSize: pdfLayout.title_font_size || 22,
    },
  ];
  // Accent rule under the title — anchors the page header visually.
  vectors.push({
    shape: {
      kind: 'rect',
      x: titleX,
      y: titleY + 6,
      width: 64,
      height: 3,
    },
    fillColor: accentFill,
    fillOpacity: 1,
  });

  let cursorY = (pdfLayout.title_y || 42) + 42;
  if (brief.payload.summary) {
    elements.push({
      type: 'text',
      x: pdfLayout.margin_left || 48,
      y: cursorY,
      text: brief.payload.summary,
      fontSize: pdfLayout.summary_font_size || 11,
    });
    cursorY += pdfLayout.summary_gap || 30;
  }

  if (contentsEntry && Array.isArray(contentsEntry.body) && contentsEntry.body.length > 0) {
    elements.push({
      type: 'text',
      x: pdfLayout.margin_left || 48,
      y: cursorY,
      text: contentsEntry.title || resolveDocumentContentsLabel(brief.locale),
      fontSize: pdfLayout.section_font_size || 14,
      color: hexToPdfRgb(themePrimary, [0.12, 0.16, 0.22]),
    });
    cursorY += 22;
    for (const line of contentsEntry.body) {
      elements.push({
        type: 'text',
        x: pdfLayout.content_x || 56,
        y: cursorY,
        text: String(line),
        fontSize: pdfLayout.body_font_size || 10,
      });
      cursorY += pdfLayout.line_height || 16;
    }
    cursorY += pdfLayout.section_gap || 10;
  }

  const contentX = pdfLayout.content_x || 56;
  const pageImages: Array<{ x: number; y: number; width: number; height: number; path: string }> =
    [];

  // ── Pagination ─────────────────────────────────────────────────────
  // Elements/vectors/images are emitted in a single vertical "flow"
  // coordinate space; afterwards they are partitioned into page bands of
  // `usableH` points (top-down). ensureSpace keeps indivisible blocks
  // (cards, quote boxes, tables' header row) from straddling a break.
  const pageHeightPt = 842;
  const contentTopPt = Number(pdfLayout.page_content_top || 42);
  const contentBottomPt = Number(pdfLayout.page_content_bottom || 40);
  const usableH = Math.max(200, pageHeightPt - contentTopPt - contentBottomPt);
  const pageOfY = (y: number) => Math.max(0, Math.floor(y / usableH));
  const ensureSpace = (needed: number) => {
    const bandEnd = (pageOfY(cursorY) + 1) * usableH;
    if (cursorY + needed > bandEnd) {
      cursorY = bandEnd;
    }
  };
  const toPageLocalY = (y: number) => {
    const pi = pageOfY(y);
    return pi === 0 ? y : y - pi * usableH + contentTopPt;
  };
  const surfaceFillPdf = hexToPdfRgb(
    (activeTheme as any)?.colors?.surface || (activeTheme as any)?.theme?.colors?.surface,
    [0.94, 0.94, 0.96]
  );
  const mutedRgb = hexToPdfRgb(
    (activeTheme as any)?.colors?.muted_text || (activeTheme as any)?.theme?.colors?.muted_text,
    [0.3, 0.3, 0.3]
  );

  // Text wrapping — PDF text ops place raw strings with no line breaking,
  // so prose must be wrapped to the content width here. Reuse the deck's
  // deterministic font-metric measurement (advance-width classes measured
  // against Noto Sans JP / Inter; CJK breaks anywhere, latin at spaces).
  const estimateTextWidth = (text: string, fontSize: number) =>
    measureTextWidthPt(String(text), fontSize);
  const wrapText = (text: string, maxWidth: number, fontSize: number): string[] =>
    wrapLine(String(text), maxWidth, fontSize);
  const pushWrappedText = (text: string, x: number, fontSize: number, color?: any, indentW = 0) => {
    const lines = wrapText(text, tableWidth - (x - contentX) - indentW, fontSize);
    for (const line of lines) {
      elements.push({ type: 'text', x, y: cursorY, text: line, fontSize, color });
      cursorY += pdfLayout.line_height || 16;
    }
  };

  for (const section of brief.payload.sections) {
    const sm = normalizeStructuredSection(section);
    const sectionId = String(section.heading || 'section')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    const sectionPlan = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === sectionId)
      : null;
    const semanticType =
      sectionPlan?.semantic_type ||
      classifyRenderSemantic(sectionPlan?.layout_key, sectionPlan?.media_kind);
    const semanticTokens = deps.resolveSemanticComponentRule(rootDir, semanticType, 'pdf', 'body');
    const pdfTokens = semanticTokens.pdf || semanticTokens;
    const isAppendix = semanticType === 'appendix';
    const sectionHeaderColor =
      pdfTokens.header_color === 'secondary'
        ? hexToPdfRgb(themeSecondary, [0.3, 0.34, 0.39])
        : pdfTokens.header_color === 'accent'
          ? hexToPdfRgb(themeAccent, [0.15, 0.39, 0.92])
          : hexToPdfRgb(themePrimary, [0.12, 0.16, 0.22]);
    const sectionBodyX =
      pdfTokens.body_x === 'margin' ? pdfLayout.margin_left || 48 : pdfLayout.content_x || 56;
    const bodyFontSize =
      (pdfLayout.body_font_size || 10) + Number(pdfTokens.body_font_size_delta || 0);
    const blockFill =
      pdfTokens.block_fill === 'primary'
        ? headerFill
        : pdfTokens.block_fill === 'accent'
          ? accentFill
          : null;
    if (sm.divider) {
      // Explicit chapter break — the section starts on a fresh page.
      // (ceil, not floor+1: an exact band start is already a fresh page.)
      cursorY = Math.ceil(cursorY / usableH) * usableH;
    }
    // Keep the heading and at least one following line on the same page.
    ensureSpace(22 + (pdfLayout.line_height || 16));
    elements.push({
      type: 'text',
      x: pdfLayout.margin_left || 48,
      y: cursorY,
      text: section.heading || reportSectionTitle,
      fontSize: isAppendix
        ? Math.max((pdfLayout.section_font_size || 14) - 2, 11)
        : pdfLayout.section_font_size || 14,
      color: sectionHeaderColor,
    });
    // Accent underline rule under the section heading — a short, thick
    // accent bar reads as a deliberate design anchor.
    vectors.push({
      shape: {
        kind: 'rect',
        x: pdfLayout.margin_left || 48,
        y: cursorY + 6,
        width: isAppendix ? 28 : 36,
        height: 2.5,
      },
      fillColor: accentFill,
      fillOpacity: 1,
    });
    cursorY += 22;
    if (blockFill) {
      const blockHeight = Math.max(
        (Array.isArray(section.body) ? section.body.length : 0) * (pdfLayout.line_height || 16) +
          18,
        26
      );
      vectors.push({
        shape: {
          kind: 'rect',
          x: (pdfLayout.margin_left || 48) - 8,
          y: cursorY - 8,
          width: 490,
          height: blockHeight,
        },
        fillColor: blockFill,
        fillOpacity: Number(pdfTokens.block_opacity || 0),
      });
    }
    if (Array.isArray(section.body)) {
      for (const paragraph of section.body) {
        pushWrappedText(String(paragraph), sectionBodyX, bodyFontSize);
      }
    }
    if (Array.isArray(section.bullets)) {
      for (const bullet of section.bullets) {
        pushWrappedText(
          `• ${String(bullet)}`,
          pdfLayout.bullet_x || 64,
          pdfLayout.body_font_size || 10,
          undefined,
          12
        );
      }
    }
    if (Array.isArray(section.callouts)) {
      for (const callout of section.callouts) {
        const title = [callout.title, callout.tone ? `(${callout.tone})` : '']
          .filter(Boolean)
          .join(' ');
        const calloutBoxHeight = callout.body
          ? (pdfLayout.line_height || 16) *
            (1 +
              wrapText(String(callout.body), tableWidth - 30, pdfLayout.body_font_size || 10)
                .length)
          : (pdfLayout.line_height || 16) + 4;
        ensureSpace(calloutBoxHeight + 4);
        const calloutBoxY = cursorY - 4;
        vectors.push({
          shape: {
            kind: 'rect',
            x: (pdfLayout.callout_x || 64) - 8,
            y: calloutBoxY,
            width: 470,
            height: calloutBoxHeight,
          },
          fillColor: pdfTokens.callout_fill === 'primary' ? headerFill : accentFill,
          fillOpacity: Number(pdfTokens.callout_opacity ?? 0.7),
        });
        if (title) {
          elements.push({
            type: 'text',
            x: pdfLayout.callout_x || 64,
            y: cursorY,
            text: title,
            fontSize: pdfLayout.callout_title_font_size || 11,
          });
          cursorY += pdfLayout.line_height || 16;
        }
        if (callout.body) {
          pushWrappedText(
            String(callout.body),
            pdfLayout.callout_x || 64,
            pdfLayout.body_font_size || 10
          );
        }
        cursorY += pdfLayout.callout_gap || 18;
      }
    }
    if (Array.isArray(section.tables)) {
      for (const table of section.tables) {
        if (table.title) {
          ensureSpace(pdfLayout.line_height || 16);
          elements.push({
            type: 'text',
            x: pdfLayout.table_x || 56,
            y: cursorY,
            text: String(table.title),
            fontSize: pdfLayout.table_title_font_size || 11,
          });
          cursorY += pdfLayout.line_height || 16;
        }
        const columns = Array.isArray(table.columns)
          ? table.columns.map((value: any) => String(value))
          : [];
        const rows = Array.isArray(table.rows) ? table.rows : [];
        const columnCount1 =
          columns.length > 0
            ? columns.length
            : Math.max(0, ...rows.map((r: any) => (Array.isArray(r) ? r.length : 1)));
        if (columnCount1 > 0) {
          const tableX = pdfLayout.table_x || 56;
          const columnWidth = tableWidth / columnCount1;
          const rowHeight = pdfLayout.line_height || 16;
          const hasHeader = columns.length > 0;
          if (hasHeader) ensureSpace(rowHeight + 8);
          const tableHeaderY = cursorY - 4;
          // Wrap each cell to its column width — row height follows the
          // tallest cell so long values don't bleed into the next column.
          const cellPadX1 = 10;
          const rowHeights1 = rows.map((row: any) => {
            const values = Array.isArray(row) ? row : columns.map((c: string) => row?.[c] ?? '');
            const maxLines = Math.max(
              1,
              ...values.map(
                (v: any) =>
                  wrapText(String(v ?? ''), columnWidth - cellPadX1, pdfLayout.body_font_size || 10)
                    .length
              )
            );
            return maxLines * rowHeight;
          });
          const tableHeight =
            (hasHeader ? rowHeight + 4 : 0) + rowHeights1.reduce((a, b) => a + b, 0);
          const drawTableHeader = () => {
            vectors.push({
              shape: {
                kind: 'rect',
                x: tableX - 4,
                y: cursorY - 4,
                width: tableWidth,
                height: rowHeight + 4,
              },
              fillColor: headerFill,
              fillOpacity: 0.95,
            });
            columns.forEach((column: string, index: number) => {
              elements.push({
                type: 'text',
                x: tableX + columnWidth * index + 4,
                y: cursorY,
                text: column,
                fontSize: pdfLayout.body_font_size || 10,
                color: [1, 1, 1],
              });
            });
          };
          if (hasHeader) {
            drawTableHeader();
            cursorY += rowHeight;
          }
          vectors.push({
            shape: {
              kind: 'rect',
              x: tableX - 4,
              y: tableHeaderY,
              width: tableWidth,
              height: tableHeight,
            },
            strokeColor: outerStroke,
            lineWidth: 0.7,
          });
          for (let index = 1; index < columnCount1; index += 1) {
            vectors.push({
              shape: {
                kind: 'line',
                x1: tableX + columnWidth * index - 4,
                y1: tableHeaderY,
                x2: tableX + columnWidth * index - 4,
                y2: tableHeaderY + tableHeight,
              },
              strokeColor: gridStroke,
              lineWidth: 0.4,
            });
          }
          // Repeat the header row whenever a data row lands on a new page
          // band — the PDF equivalent of docx `tblHeader`.
          let headerBand = pageOfY(cursorY);
          rows.forEach((row: any, rowIndex: number) => {
            if (hasHeader && pageOfY(cursorY) !== headerBand) {
              cursorY = Math.ceil(cursorY / usableH) * usableH;
              drawTableHeader();
              cursorY += rowHeight;
              headerBand = pageOfY(cursorY);
            }
            const values = Array.isArray(row)
              ? row
              : columns.map((column: string) => row?.[column] ?? '');
            const thisRowH = rowHeights1[rowIndex] || rowHeight;
            if (showZebra && rowIndex % 2 === 1) {
              vectors.push({
                shape: {
                  kind: 'rect',
                  x: tableX - 4,
                  y: cursorY - 4,
                  width: tableWidth,
                  height: thisRowH,
                },
                fillColor: zebraFill,
                fillOpacity: 0.6,
              });
            }
            vectors.push({
              shape: {
                kind: 'line',
                x1: tableX - 4,
                y1: cursorY - 2,
                x2: tableX + tableWidth - 4,
                y2: cursorY - 2,
              },
              strokeColor: gridStroke,
              lineWidth: 0.5,
            });
            values.forEach((value: any, index: number) => {
              const cellLines = wrapText(
                String(value ?? ''),
                columnWidth - cellPadX1,
                pdfLayout.body_font_size || 10
              );
              cellLines.forEach((line, li) => {
                elements.push({
                  type: 'text',
                  x: tableX + columnWidth * index + 4,
                  y: cursorY + li * rowHeight,
                  text: line,
                  fontSize: pdfLayout.body_font_size || 10,
                });
              });
            });
            cursorY += thisRowH;
          });
          cursorY += pdfLayout.table_gap || 22;
        }
      }
    }

    // Singular `table` — same field shape as the slide/report path.
    if (sm.table) {
      const table = sm.table;
      const columns = table.columns;
      const rows = table.rows;
      const columnCount2 =
        columns.length > 0
          ? columns.length
          : Math.max(0, ...rows.map((r: any) => (Array.isArray(r) ? r.length : 1)));
      if (columnCount2 > 0) {
        const tableX = pdfLayout.table_x || 56;
        const colWidthsPt: number[] =
          Array.isArray(table.colWidths) && table.colWidths.length >= columnCount2
            ? table.colWidths.map((w: any) =>
                Math.max(40, Math.round(Number(w) * 72) || Math.floor(tableWidth / columnCount2))
              )
            : Array.from({ length: columnCount2 }, () => tableWidth / columnCount2);
        const tableWidthPt = colWidthsPt.reduce((a: number, b: number) => a + b, 0);
        const rowHeight = pdfLayout.line_height || 16;
        const hasHeader = columns.length > 0;
        if (hasHeader) ensureSpace(rowHeight + 8);
        const tableHeaderY = cursorY - 4;
        const cellPadX2 = 10;
        const rowHeights2 = rows.map((row: any) => {
          const values = Array.isArray(row) ? row : columns.map((c: string) => row?.[c] ?? '');
          const maxLines = Math.max(
            1,
            ...values.map(
              (v: any, vi: number) =>
                wrapText(
                  String(v ?? ''),
                  (colWidthsPt[vi] || tableWidth / columnCount2) - cellPadX2,
                  pdfLayout.body_font_size || 10
                ).length
            )
          );
          return maxLines * rowHeight;
        });
        const tableHeight =
          (hasHeader ? rowHeight + 4 : 0) + rowHeights2.reduce((a, b) => a + b, 0);
        const drawTableHeader = () => {
          vectors.push({
            shape: {
              kind: 'rect',
              x: tableX - 4,
              y: cursorY - 4,
              width: tableWidthPt,
              height: rowHeight + 4,
            },
            fillColor: headerFill,
            fillOpacity: 0.95,
          });
          columns.forEach((column: string, index: number) => {
            const cx =
              tableX + colWidthsPt.slice(0, index).reduce((a: number, b: number) => a + b, 0);
            elements.push({
              type: 'text',
              x: cx + 4,
              y: cursorY,
              text: column,
              fontSize: pdfLayout.body_font_size || 10,
              color: [1, 1, 1],
            });
          });
        };
        if (hasHeader) {
          drawTableHeader();
          cursorY += rowHeight;
        }
        vectors.push({
          shape: {
            kind: 'rect',
            x: tableX - 4,
            y: tableHeaderY,
            width: tableWidthPt,
            height: tableHeight,
          },
          strokeColor: outerStroke,
          lineWidth: 0.7,
        });
        for (let index = 1; index < columnCount2; index += 1) {
          const cx =
            tableX + colWidthsPt.slice(0, index).reduce((a: number, b: number) => a + b, 0);
          vectors.push({
            shape: {
              kind: 'line',
              x1: cx - 4,
              y1: tableHeaderY,
              x2: cx - 4,
              y2: tableHeaderY + tableHeight,
            },
            strokeColor: gridStroke,
            lineWidth: 0.4,
          });
        }
        let headerBand = pageOfY(cursorY);
        rows.forEach((row: any, rowIndex: number) => {
          if (hasHeader && pageOfY(cursorY) !== headerBand) {
            cursorY = Math.ceil(cursorY / usableH) * usableH;
            drawTableHeader();
            cursorY += rowHeight;
            headerBand = pageOfY(cursorY);
          }
          const values = Array.isArray(row)
            ? row
            : columns.map((column: string) => row?.[column] ?? '');
          const thisRowH = rowHeights2[rowIndex] || rowHeight;
          vectors.push({
            shape: {
              kind: 'line',
              x1: tableX - 4,
              y1: cursorY - 2,
              x2: tableX + tableWidthPt - 4,
              y2: cursorY - 2,
            },
            strokeColor: gridStroke,
            lineWidth: 0.5,
          });
          values.forEach((value: any, index: number) => {
            const cx =
              tableX + colWidthsPt.slice(0, index).reduce((a: number, b: number) => a + b, 0);
            const cellLines = wrapText(
              String(value ?? ''),
              (colWidthsPt[index] || tableWidth / columnCount2) - cellPadX2,
              pdfLayout.body_font_size || 10
            );
            cellLines.forEach((line, li) => {
              elements.push({
                type: 'text',
                x: cx + 4,
                y: cursorY + li * rowHeight,
                text: line,
                fontSize: pdfLayout.body_font_size || 10,
              });
            });
          });
          cursorY += thisRowH;
        });
        cursorY += pdfLayout.table_gap || 22;
      }
    }

    cursorY = appendStructuredPdfBlocks(
      sm,
      {
        elements,
        vectors,
        pageImages,
        pdfLayout,
        tableWidth,
        headerFill,
        accentFill,
        surfaceFillPdf,
        mutedRgb,
        usableH,
        estimateTextWidth,
        wrapText,
        contentX,
        sectionHeaderColor,
        rootDir,
      },
      cursorY
    );

    cursorY += pdfLayout.section_gap || 10;
  }

  return {
    version: '1.0.0',
    generatedAt: nowIso(),
    source: {
      format: 'markdown',
      title: brief.title || brief.payload?.title || 'Report',
      body: bodySections.join('\n'),
    },
    metadata: {
      title: brief.title || brief.payload?.title || 'Report',
      subject: brief.document_profile || 'summary-report',
      author: 'Kyberion Media-Actuator',
      creationDate: nowIso(),
      composition: outline,
      generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
      recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
      branding: preset?.branding || {},
      sectionSemantics: Array.isArray(outline.toc)
        ? outline.toc.map((entry: any) => ({
            section_id: entry.section_id,
            layout_key: entry.layout_key,
            media_kind: entry.media_kind,
            semantic_type:
              entry.semantic_type || classifyRenderSemantic(entry.layout_key, entry.media_kind),
          }))
        : [],
    },
    content: {
      text: bodySections.join('\n'),
      pages: (() => {
        // Partition the flow-space elements/vectors/images into pages.
        // Vectors that straddle a page band are split into one clipped
        // segment per page (long table borders / grid rules survive the
        // break instead of disappearing from the continuation page).
        const shapeBandRange = (shape: any): [number, number] => {
          if (shape?.kind === 'line') {
            const lo = Math.min(shape.y1, shape.y2);
            const hi = Math.max(shape.y1, shape.y2);
            return [pageOfY(lo), pageOfY(hi)];
          }
          const top = Number(shape?.y ?? 0);
          const bottom = top + Number(shape?.height ?? 0);
          return [pageOfY(top), pageOfY(Math.max(top, bottom - 0.01))];
        };
        const vectorOnPage = (v: any, pi: number): any | null => {
          const shape = { ...v.shape };
          const bandTop = pi * usableH;
          const bandEnd = bandTop + usableH;
          const toLocal = (y: number) => (pi === 0 ? y : y - bandTop + contentTopPt);
          if (shape.kind === 'rect') {
            const top = Math.max(Number(shape.y), bandTop);
            const bottom = Math.min(Number(shape.y) + Number(shape.height || 0), bandEnd);
            // A <5pt sliver at a band edge is padding bleed from the
            // neighbouring block (rects are emitted at cursorY-4), not
            // content — drop it so it doesn't paint a stray strip.
            if (bottom - top < 5 && Number(shape.height || 0) > bottom - top) {
              return null;
            }
            shape.y = toLocal(top);
            shape.height = Math.max(0.5, bottom - top);
          } else if (shape.kind === 'line') {
            const lo = Math.min(shape.y1, shape.y2);
            const hi = Math.max(shape.y1, shape.y2);
            const segLo = Math.max(lo, bandTop);
            const segHi = Math.min(hi, bandEnd);
            if (segHi - segLo < 5 && hi - lo > segHi - segLo) {
              return null;
            }
            const y1Local = toLocal(shape.y1 === lo ? segLo : segHi);
            const y2Local = toLocal(shape.y2 === hi ? segHi : segLo);
            shape.y1 = y1Local;
            shape.y2 = y2Local;
          }
          return { ...v, shape };
        };
        const vectorsByPage = new Map<number, any[]>();
        for (const v of vectors) {
          const [pi0, pi1] = shapeBandRange(v?.shape);
          for (let pi = pi0; pi <= pi1; pi += 1) {
            const scoped = vectorOnPage(v, pi);
            if (!scoped) continue;
            if (!vectorsByPage.has(pi)) vectorsByPage.set(pi, []);
            vectorsByPage.get(pi)!.push(scoped);
          }
        }
        const maxPage = Math.max(
          ...elements.map((el: any) => pageOfY(Number(el.y ?? 0))),
          ...[...vectorsByPage.keys()],
          ...pageImages.map((img) => pageOfY(img.y)),
          0
        );
        for (const el of elements) {
          const pi = pageOfY(Number(el.y ?? 0));
          (el as any).page = pi;
          el.y = toPageLocalY(Number(el.y ?? 0));
        }
        // Per-page footer: page number centered at the bottom margin.
        const pageList = Array.from({ length: maxPage + 1 }, (_e, pi) => {
          const pageImgs = pageImages
            .filter((img) => pageOfY(img.y) === pi)
            .map((img) => ({ ...img, y: toPageLocalY(img.y) }));
          return {
            pageNumber: pi + 1,
            width: 595,
            height: pageHeightPt,
            text: '',
            vectors: vectorsByPage.get(pi) ?? [],
            images: pageImgs,
          };
        });
        pageList.forEach((_page, pi) => {
          elements.push({
            type: 'text',
            x: 595 / 2 - 4,
            y: pageHeightPt - 24,
            text: String(pi + 1),
            fontSize: 9,
            color: mutedRgb,
            page: pi,
          } as any);
          if (pi > 0) {
            // Running header so continuation pages keep document context.
            const headerTitle = String(brief.title || brief.payload?.title || '');
            elements.push({
              type: 'text',
              x: Math.max(
                pdfLayout.margin_left || 48,
                595 - 48 - estimateTextWidth(headerTitle, 9)
              ),
              y: 26,
              text: headerTitle,
              fontSize: 9,
              color: mutedRgb,
              page: pi,
            } as any);
          }
        });
        return pageList;
      })(),
    },
    aesthetic: {
      layout: 'single-column',
      elements,
      colors: [themePrimary, themeSecondary, themeAccent],
      fonts: [brief.locale?.startsWith('ja') ? 'HeiseiKakuGo-W5' : 'Helvetica'],
      branding: {
        logoPresence: Boolean(preset?.branding?.logo_url || activeTheme?.assets?.logo_url),
        logoUrl: preset?.branding?.logo_url || activeTheme?.assets?.logo_url || null,
        brandName: preset?.branding?.brand_name || brief.payload?.client || brief.client || null,
        primaryColor: themePrimary,
        secondaryColor: themeSecondary,
        backgroundColor: themeBackground,
        tone: preset?.branding?.tone || 'professional',
      },
      templateId,
    },
    renderOptions: {
      compress: true,
      unicode: true,
      xmpMetadata: true,
      tagged: false,
      linearize: false,
      objectStreams: false,
    },
  };
}
