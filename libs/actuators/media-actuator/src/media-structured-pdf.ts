/** PDF structured-content renderers — extracted from
 * `media-report-pdf-builder.ts` (file-length policy). Emits
 * `elements`/`vectors`/`pageImages` in the builder's single "flow"
 * coordinate space; page-band splitting happens afterwards in the builder.
 *
 * The function takes the current `cursorY` and returns the advanced
 * `cursorY`; `ensureSpace`/`wrapText`/`estimateTextWidth` come in as ctx so
 * this module stays consistent with the builder's pagination + metrics.
 */
import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { getPngDisplaySize } from './media-layout-catalog.js';
import type { StructuredSectionModel } from './media-structured-content.js';

export interface PdfStructuredCtx {
  elements: any[];
  vectors: any[];
  pageImages: any[];
  pdfLayout: any;
  /** Content width in pt. */
  tableWidth: number;
  /** Resolved theme fills (RGB 0-1 tuples). */
  headerFill: [number, number, number];
  accentFill: [number, number, number];
  surfaceFillPdf: [number, number, number];
  mutedRgb: [number, number, number];
  /** Page band height (points) — ensureSpace uses it to keep blocks atomic. */
  usableH: number;
  /** Text measuring + wrapping (deck font metrics). */
  estimateTextWidth: (text: string, fontSize: number) => number;
  wrapText: (text: string, maxWidth: number, fontSize: number) => string[];
  /** Content column x (pdfLayout.content_x ?? 56). */
  contentX: number;
  /** Per-section heading fill (semantic token driven). */
  sectionHeaderColor: [number, number, number];
  /** Repo root for image path validation. */
  rootDir: string;
}

/**
 * Append structured-section content for one section, starting at
 * `ctx.cursorY` flow-space. Returns the advanced cursor position.
 */
export function appendStructuredPdfBlocks(
  sm: StructuredSectionModel,
  ctx: PdfStructuredCtx,
  startCursorY: number
): number {
  const {
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
  } = ctx;
  // Local wrapped-text emitter bound to *this* call's cursor — the builder's
  // own pushWrappedText closes over the builder's cursorY, which doesn't move
  // while this function runs.
  const pushWrappedText = (text: string, x: number, fontSize: number, color?: any, indentW = 0) => {
    wrapText(text, tableWidth - (x - contentX) - indentW, fontSize).forEach((line) => {
      elements.push({ type: 'text', x, y: cursorY, text: line, fontSize, color });
      cursorY += pdfLayout.line_height || 16;
    });
  };
  let cursorY = startCursorY;
  const ensureSpace = (needed: number) => {
    const bandEnd = (Math.max(0, Math.floor(cursorY / usableH)) + 1) * usableH;
    if (cursorY + needed > bandEnd) cursorY = bandEnd;
  };
  // ── Structured components — same typed fields as docx/pptx ──────────
  const metrics = sm.metrics.slice(0, 6);
  if (metrics.length > 0) {
    const metricW = tableWidth / metrics.length;
    const metricH = (pdfLayout.line_height || 16) * 3;
    ensureSpace(metricH);
    const metricY = cursorY - 4;
    metrics.forEach((metric, index) => {
      const x = contentX + metricW * index;
      vectors.push({
        shape: { kind: 'rect', x, y: metricY, width: metricW - 8, height: metricH },
        fillColor: surfaceFillPdf,
        fillOpacity: 1,
      });
      vectors.push({
        shape: { kind: 'rect', x, y: metricY, width: 3, height: metricH },
        fillColor: accentFill,
        fillOpacity: 1,
      });
      elements.push({
        type: 'text',
        x: x + 10,
        y: metricY + 20,
        text: metric.value,
        fontSize: 20,
        color: sectionHeaderColor,
      });
      if (metric.label) {
        elements.push({
          type: 'text',
          x: x + 10,
          y: metricY + metricH - 10,
          text: metric.label,
          fontSize: pdfLayout.body_font_size || 10,
          color: mutedRgb,
        });
      }
    });
    cursorY += metricH + (pdfLayout.section_gap || 10);
  }

  const steps = sm.steps.slice(0, 6);
  if (steps.length > 0) {
    const stepW = tableWidth / steps.length;
    const rowH = pdfLayout.line_height || 16;
    const stepsHaveDesc = steps.some((step) => step.description);
    ensureSpace(rowH + 8 + (stepsHaveDesc ? rowH * 1.6 : 0));
    const stepY = cursorY - 4;
    steps.forEach((step, index) => {
      const x = contentX + stepW * index;
      vectors.push({
        shape: { kind: 'rect', x, y: stepY, width: stepW - 8, height: rowH + 6 },
        fillColor: index === steps.length - 1 ? accentFill : headerFill,
        fillOpacity: index === steps.length - 1 ? 1 : 0.95,
      });
      elements.push({
        type: 'text',
        x: x + 8,
        y: stepY + rowH - 4,
        text: step.title,
        fontSize: pdfLayout.body_font_size || 10,
        color: [1, 1, 1],
      });
      if (stepsHaveDesc && step.description) {
        vectors.push({
          shape: { kind: 'rect', x, y: stepY + rowH + 8, width: stepW - 8, height: rowH * 1.6 },
          fillColor: surfaceFillPdf,
          fillOpacity: 1,
        });
        const descFs = Math.max((pdfLayout.body_font_size || 10) - 1, 8);
        const descLines = wrapText(step.description, stepW - 22, descFs).slice(0, 2);
        descLines.forEach((line, li) => {
          elements.push({
            type: 'text',
            x: x + 8,
            y: stepY + rowH + 8 + rowH + li * (rowH * 0.7),
            text: line,
            fontSize: descFs,
            color: mutedRgb,
          });
        });
      }
    });
    cursorY += rowH + 8 + (stepsHaveDesc ? rowH * 1.6 : 0) + (pdfLayout.section_gap || 10);
  }

  const columnBlocks = sm.columns.slice(0, 3);
  if (columnBlocks.length > 0) {
    const colW = tableWidth / columnBlocks.length;
    const maxLines = Math.max(
      ...columnBlocks.map((c) =>
        c.items.reduce(
          (acc: number, item: string) =>
            acc +
            wrapText(
              `• ${item}`,
              tableWidth / columnBlocks.length - 28,
              pdfLayout.body_font_size || 10
            ).length,
          0
        )
      )
    );
    const colH = (pdfLayout.line_height || 16) + 8 + maxLines * (pdfLayout.line_height || 16);
    ensureSpace(colH);
    const colY = cursorY - 4;
    columnBlocks.forEach((column, index) => {
      const x = contentX + colW * index;
      vectors.push({
        shape: { kind: 'rect', x, y: colY, width: colW - 8, height: colH },
        fillColor: surfaceFillPdf,
        fillOpacity: 1,
      });
      let innerY = colY + (pdfLayout.line_height || 16);
      if (column.title) {
        elements.push({
          type: 'text',
          x: x + 10,
          y: innerY,
          text: column.title,
          fontSize: (pdfLayout.body_font_size || 10) + 1,
          color: sectionHeaderColor,
        });
        innerY += pdfLayout.line_height || 16;
      }
      for (const item of column.items) {
        elements.push({
          type: 'text',
          x: x + 10,
          y: innerY,
          text: `• ${item}`,
          fontSize: pdfLayout.body_font_size || 10,
        });
        innerY += pdfLayout.line_height || 16;
      }
    });
    cursorY += colH + (pdfLayout.section_gap || 10);
  }

  const checklist = sm.checklist;
  for (const item of checklist) {
    ensureSpace(pdfLayout.line_height || 16);
    pushWrappedText(
      `${item.done ? '☑' : '☐'} ${item.text}`,
      pdfLayout.bullet_x || 64,
      pdfLayout.body_font_size || 10,
      undefined,
      14
    );
  }

  if (sm.quote) {
    const quote = sm.quote;
    if (quote.text) {
      ensureSpace((pdfLayout.line_height || 16) * 2.4);
      const quoteY = cursorY - 2;
      vectors.push({
        shape: {
          kind: 'line',
          x1: pdfLayout.callout_x || 64,
          y1: quoteY,
          x2: pdfLayout.callout_x || 64,
          y2: quoteY + (pdfLayout.line_height || 16) * (quote.attribution ? 2.4 : 1.6),
        },
        strokeColor: accentFill,
        lineWidth: 2.2,
      });
      for (const line of wrapText(
        `「${quote.text}」`,
        tableWidth - 40,
        (pdfLayout.body_font_size || 10) + 3
      )) {
        elements.push({
          type: 'text',
          x: (pdfLayout.callout_x || 64) + 12,
          y: cursorY,
          text: line,
          fontSize: (pdfLayout.body_font_size || 10) + 3,
          color: sectionHeaderColor,
        });
        cursorY += (pdfLayout.line_height || 16) * 1.5;
      }
      if (quote.attribution) {
        elements.push({
          type: 'text',
          x: (pdfLayout.callout_x || 64) + 12,
          y: cursorY,
          text: `— ${quote.attribution}`,
          fontSize: Math.max((pdfLayout.body_font_size || 10) - 1, 8),
          color: mutedRgb,
        });
        cursorY += pdfLayout.line_height || 16;
      }
    }
  }

  if (sm.cta) {
    const ctaText = sm.cta;
    if (ctaText) {
      const ctaH = (pdfLayout.line_height || 16) + 14;
      ensureSpace(ctaH + 8);
      vectors.push({
        shape: {
          kind: 'rect',
          x: contentX - 8,
          y: cursorY - 4,
          width: tableWidth,
          height: ctaH,
        },
        fillColor: accentFill,
        fillOpacity: 1,
      });
      elements.push({
        type: 'text',
        x: contentX + 4,
        y: cursorY + ctaH - 16,
        text: `→ ${ctaText}`,
        fontSize: (pdfLayout.body_font_size || 10) + 2,
        color: [1, 1, 1],
      });
      cursorY += ctaH + 8;
    }
  }

  // wbs — indented hierarchy: L1 accent marker + bold, deeper levels
  // indented with tree connectors.
  if (sm.wbs.length > 0) {
    for (const entry of sm.wbs.slice(0, 40)) {
      const level = Math.min(entry.level, 4);
      ensureSpace((pdfLayout.line_height || 16) + 2);
      const x = (pdfLayout.content_x || 56) + 8 + (level - 1) * 18;
      if (level === 1) {
        vectors.push({
          shape: {
            kind: 'rect',
            x: pdfLayout.content_x || 56,
            y: cursorY - 9,
            width: 3,
            height: 11,
          },
          fillColor: accentFill,
          fillOpacity: 1,
        });
      }
      elements.push({
        type: 'text',
        x,
        y: cursorY,
        text: (level === 1 ? '' : level === 2 ? '├ ' : '└ ') + entry.label,
        fontSize:
          level === 1 ? (pdfLayout.body_font_size || 10) + 1 : pdfLayout.body_font_size || 10,
        color: level === 1 ? accentFill : undefined,
      });
      cursorY += (pdfLayout.line_height || 16) + 2;
    }
    cursorY += pdfLayout.section_gap || 8;
  }

  // timeline — real proportional Gantt bars when dates parse;
  // milestone list otherwise.
  if (sm.timeline.length > 0) {
    const entries = sm.timeline;
    const toOrd = (s: string): number | null => {
      const m = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/.exec(s);
      if (!m) return null;
      return Number(m[1]) + (Number(m[2] || 1) - 1) / 12 + (Number(m[3] || 1) - 1) / 365;
    };
    const ranged = entries.length > 0 && entries.every((e) => toOrd(e.start) !== null);
    const rowH = pdfLayout.line_height || 16;
    if (ranged) {
      const lo = Math.min(...entries.map((e) => toOrd(e.start)!));
      const hi = Math.max(...entries.map((e) => toOrd(e.end || e.start)!), lo + 0.001);
      const labelW = 140;
      const trackX = (pdfLayout.table_x || 56) + labelW;
      const trackW = tableWidth - labelW;
      entries.slice(0, 14).forEach((entry, i) => {
        ensureSpace(rowH + 10);
        elements.push({
          type: 'text',
          x: pdfLayout.table_x || 56,
          y: cursorY,
          text: entry.label + (entry.owner ? `（${entry.owner}）` : ''),
          fontSize: pdfLayout.body_font_size || 10,
        });
        const s = toOrd(entry.start)!;
        const e = Math.max(toOrd(entry.end || entry.start)!, s + 0.02);
        const bx = trackX + ((s - lo) / (hi - lo)) * trackW;
        const bw = Math.max(18, ((e - s) / (hi - lo)) * trackW);
        vectors.push({
          shape: { kind: 'rect', x: bx, y: cursorY - 7, width: bw, height: 11 },
          fillColor: i === entries.length - 1 ? accentFill : headerFill,
          fillOpacity: 0.9,
        });
        elements.push({
          type: 'text',
          x: bx + 3,
          y: cursorY,
          text: entry.end ? `${entry.start}–${entry.end}` : entry.start,
          fontSize: Math.max((pdfLayout.body_font_size || 10) - 2, 8),
          color: [1, 1, 1],
        });
        cursorY += rowH + 8;
      });
      cursorY += pdfLayout.section_gap || 8;
    } else {
      entries.slice(0, 14).forEach((entry) => {
        ensureSpace(rowH + 2);
        elements.push({
          type: 'text',
          x: pdfLayout.bullet_x || 64,
          y: cursorY,
          text: `• ${[entry.start || entry.end, entry.label].filter(Boolean).join('  ')}${entry.owner ? `（${entry.owner}）` : ''}`,
          fontSize: pdfLayout.body_font_size || 10,
        });
        cursorY += rowH + 2;
      });
      cursorY += pdfLayout.section_gap || 8;
    }
  }

  // matrix — 2×2 surface cells with accent quadrant titles.
  const matrixRawPdf = sm.matrix;
  if (matrixRawPdf && matrixRawPdf.quadrants.length > 0) {
    const quadrants = matrixRawPdf.quadrants.slice(0, 4);
    const gapM = 8;
    const cellW = (tableWidth - gapM) / 2;
    const rowH = pdfLayout.line_height || 16;
    const quadRows = Math.ceil(quadrants.length / 2);
    for (let ri = 0; ri < quadRows; ri += 1) {
      const rowQuads = quadrants.slice(ri * 2, ri * 2 + 2);
      const quadHeights = rowQuads.map(
        (q: any) => rowH + 14 + Math.max(0, q.items?.length || 0) * (rowH * 0.9)
      );
      const quadH = Math.max(...quadHeights);
      ensureSpace(quadH + gapM);
      const quadY = cursorY;
      rowQuads.forEach((q: any, qi: number) => {
        const x = (pdfLayout.table_x || 56) + qi * (cellW + gapM);
        vectors.push({
          shape: { kind: 'rect', x, y: quadY - 8, width: cellW, height: quadH },
          fillColor: surfaceFillPdf,
          fillOpacity: 1,
        });
        if (q?.title) {
          elements.push({
            type: 'text',
            x: x + 10,
            y: quadY,
            text: String(q.title),
            fontSize: (pdfLayout.body_font_size || 10) + 1,
            color: headerFill,
          });
        }
        (Array.isArray(q?.items) ? q.items : []).forEach((item: any, ii: number) => {
          wrapText(`• ${String(item ?? '')}`, cellW - 26, pdfLayout.body_font_size || 10)
            .slice(0, 4)
            .forEach((line, li) => {
              elements.push({
                type: 'text',
                x: x + 10,
                y: quadY + rowH + ii * rowH * 0.9 + li * rowH * 0.9,
                text: line,
                fontSize: pdfLayout.body_font_size || 10,
              });
            });
        });
      });
      cursorY += quadH + gapM;
    }
    if (matrixRawPdf.xAxis) {
      elements.push({
        type: 'text',
        x: 595 / 2 - estimateTextWidth(String(matrixRawPdf.xAxis), 9) / 2,
        y: cursorY,
        text: String(matrixRawPdf.xAxis),
        fontSize: 9,
        color: mutedRgb,
      });
      cursorY += pdfLayout.line_height || 16;
    }
  }

  // process — vertical flow of numbered surface boxes.
  if (sm.process.length > 0) {
    const flowSteps = sm.process;
    const stepRowH = (pdfLayout.line_height || 16) + 14;
    flowSteps.slice(0, 16).forEach((step, i) => {
      ensureSpace(stepRowH);
      const y = cursorY;
      vectors.push({
        shape: {
          kind: 'rect',
          x: pdfLayout.table_x || 56,
          y: y - 9,
          width: tableWidth * 0.72,
          height: stepRowH - 8,
        },
        fillColor: surfaceFillPdf,
        fillOpacity: 1,
      });
      vectors.push({
        shape: {
          kind: 'rect',
          x: pdfLayout.table_x || 56,
          y: y - 9,
          width: 3,
          height: stepRowH - 8,
        },
        fillColor: i === 0 ? accentFill : headerFill,
        fillOpacity: 1,
      });
      elements.push({
        type: 'text',
        x: (pdfLayout.table_x || 56) + 12,
        y,
        text: `${i + 1}. ${step.label}${step.description ? ` — ${step.description}` : ''}`,
        fontSize: pdfLayout.body_font_size || 10,
      });
      cursorY += stepRowH;
    });
    cursorY += pdfLayout.section_gap || 8;
  }

  // org — indented hierarchy lines (same visual language as wbs,
  // with role annotation).
  if (sm.org.length > 0) {
    const flat = sm.org;
    flat.slice(0, 30).forEach((member) => {
      const level = Math.min(member.level, 4);
      ensureSpace(pdfLayout.line_height || 16);
      if (level === 1) {
        vectors.push({
          shape: {
            kind: 'rect',
            x: pdfLayout.content_x || 56,
            y: cursorY - 8,
            width: 3,
            height: 11,
          },
          fillColor: accentFill,
          fillOpacity: 1,
        });
      }
      elements.push({
        type: 'text',
        x: (pdfLayout.content_x || 56) + 8 + (level - 1) * 20,
        y: cursorY,
        text: (level === 1 ? '◆ ' : '– ') + member.name + (member.role ? `（${member.role}）` : ''),
        fontSize: pdfLayout.body_font_size || 10,
        color: level === 1 ? accentFill : undefined,
      });
      cursorY += pdfLayout.line_height || 16;
    });
    cursorY += pdfLayout.section_gap || 8;
  }

  // pyramid — centered bands of decreasing width (apex narrow, base wide).
  if (sm.pyramid.length > 0) {
    const layers = sm.pyramid;
    const n = layers.length;
    const bandH = (pdfLayout.line_height || 16) + 8;
    const cx = (pdfLayout.table_x || 56) + tableWidth / 2;
    const narrowest = tableWidth * 0.3;
    layers.forEach((layer, i) => {
      const w = narrowest + (tableWidth - narrowest) * (i / Math.max(n - 1, 1));
      const x = cx - w / 2;
      ensureSpace(bandH + 4);
      const isApex = i === 0;
      const isBase = i === n - 1;
      vectors.push({
        shape: { kind: 'rect', x, y: cursorY - 8, width: w, height: bandH - 3 },
        fillColor: isApex ? headerFill : isBase ? accentFill : surfaceFillPdf,
        fillOpacity: 1,
      });
      elements.push({
        type: 'text',
        x: x + 8,
        y: cursorY,
        text: layer.label + (layer.description ? ` — ${layer.description}` : ''),
        fontSize: pdfLayout.body_font_size || 10,
        color: isApex || isBase ? [1, 1, 1] : undefined,
      });
      cursorY += bandH;
    });
    cursorY += pdfLayout.section_gap || 8;
  }

  // flow — swimlane rows: label rect + arrow-joined step boxes.
  if (sm.flow.length > 0) {
    const lanes = sm.flow.map((l) => ({
      lane: l.lane,
      steps: l.steps.map((s) => s.label),
    }));
    const laneLabelW = 100;
    const laneH = (pdfLayout.line_height || 16) + 16;
    lanes.slice(0, 8).forEach((lane, li) => {
      ensureSpace(laneH + 6);
      const y = cursorY;
      vectors.push({
        shape: {
          kind: 'rect',
          x: pdfLayout.table_x || 56,
          y: y - 10,
          width: laneLabelW,
          height: laneH - 6,
        },
        fillColor: headerFill,
        fillOpacity: 1,
      });
      elements.push({
        type: 'text',
        x: (pdfLayout.table_x || 56) + 6,
        y,
        text: lane.lane || `Lane ${li + 1}`,
        fontSize: pdfLayout.body_font_size || 10,
        color: [1, 1, 1],
      });
      // steps joined by → on a surface band
      const laneX = (pdfLayout.table_x || 56) + laneLabelW + 4;
      vectors.push({
        shape: {
          kind: 'rect',
          x: laneX,
          y: y - 10,
          width: tableWidth - laneLabelW - 4,
          height: laneH - 6,
        },
        fillColor: surfaceFillPdf,
        fillOpacity: 1,
      });
      const stepText = lane.steps.join('  →  ');
      elements.push({
        type: 'text',
        x: laneX + 8,
        y,
        text: stepText,
        fontSize: pdfLayout.body_font_size || 10,
      });
      cursorY += laneH;
    });
    cursorY += pdfLayout.section_gap || 8;
  }

  // roadmap — period cards as a column row.
  if (sm.roadmap.length > 0) {
    const periods = sm.roadmap.slice(0, 5);
    if (periods.length > 0) {
      const gapR = 8;
      const cardW = (tableWidth - (periods.length - 1) * gapR) / periods.length;
      const rowH = pdfLayout.line_height || 16;
      const maxItems = Math.max(...periods.map((p) => p.items.length));
      const cardH = rowH * 2 + maxItems * rowH * 0.85 + 14;
      ensureSpace(cardH + 10);
      const cardY = cursorY;
      periods.forEach((period, i) => {
        const x = (pdfLayout.table_x || 56) + i * (cardW + gapR);
        vectors.push({
          shape: { kind: 'rect', x, y: cardY - 6, width: cardW, height: cardH },
          fillColor: surfaceFillPdf,
          fillOpacity: 1,
        });
        vectors.push({
          shape: { kind: 'rect', x, y: cardY - 6, width: cardW, height: rowH + 6 },
          fillColor: i === periods.length - 1 ? accentFill : headerFill,
          fillOpacity: 1,
        });
        elements.push({
          type: 'text',
          x: x + 8,
          y: cardY,
          text: period.period || period.title,
          fontSize: pdfLayout.body_font_size || 10,
          color: [1, 1, 1],
        });
        if (period.title && period.period) {
          elements.push({
            type: 'text',
            x: x + 8,
            y: cardY + rowH + 4,
            text: period.title,
            fontSize: pdfLayout.body_font_size || 10,
            color: headerFill,
          });
        }
        period.items.forEach((item: string, ii: number) => {
          wrapText(`• ${item}`, cardW - 18, pdfLayout.body_font_size || 10)
            .slice(0, 4)
            .forEach((line, li2) => {
              elements.push({
                type: 'text',
                x: x + 8,
                y: cardY + rowH * 1.8 + ii * rowH * 0.85 + li2 * rowH * 0.85,
                text: line,
                fontSize: pdfLayout.body_font_size || 10,
              });
            });
        });
      });
      cursorY += cardH + (pdfLayout.section_gap || 8);
    }
  }

  // kpi_table — metric | value (emphasized) | target | delta rows.
  if (sm.kpiTable.length > 0) {
    const kpis = sm.kpiTable
      .map((k) => ({
        metric: k.metric,
        value: k.value,
        target: k.target,
        delta: k.delta || k.trend,
      }))
      .slice(0, 12);
    const kpiRowH = (pdfLayout.line_height || 16) + 6;
    kpis.forEach((kpi, i) => {
      ensureSpace(kpiRowH);
      const y = cursorY;
      if (i % 2 === 1) {
        vectors.push({
          shape: {
            kind: 'rect',
            x: pdfLayout.table_x || 56,
            y: y - 8,
            width: tableWidth,
            height: kpiRowH - 4,
          },
          fillColor: surfaceFillPdf,
          fillOpacity: 0.7,
        });
      }
      elements.push({
        type: 'text',
        x: pdfLayout.table_x || 56,
        y,
        text: kpi.metric,
        fontSize: pdfLayout.body_font_size || 10,
      });
      elements.push({
        type: 'text',
        x: (pdfLayout.table_x || 56) + tableWidth * 0.42,
        y: y - 2,
        text: kpi.value,
        fontSize: (pdfLayout.body_font_size || 10) + 3,
        color: headerFill,
      });
      elements.push({
        type: 'text',
        x: (pdfLayout.table_x || 56) + tableWidth * 0.62,
        y,
        text: kpi.target ? `目標 ${kpi.target}` : '',
        fontSize: Math.max((pdfLayout.body_font_size || 10) - 1, 8),
        color: mutedRgb,
      });
      if (kpi.delta) {
        elements.push({
          type: 'text',
          x: (pdfLayout.table_x || 56) + tableWidth * 0.82,
          y,
          text: kpi.delta,
          fontSize: pdfLayout.body_font_size || 10,
          color: /^[+↑▲]/.test(kpi.delta) ? accentFill : mutedRgb,
        });
      }
      cursorY += kpiRowH;
    });
    cursorY += pdfLayout.section_gap || 8;
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
          const imgW = 300;
          const dims = getPngDisplaySize(
            absoluteImage,
            Number(spec.height) || 2.6,
            Number(spec.width) || 4.5
          );
          const imgH = dims.h > 0 ? dims.h * 72 : 150;
          const imgWPt = dims.w > 0 ? dims.w * 72 : imgW;
          ensureSpace(imgH + 24);
          const imageX =
            spec.align === 'right'
              ? 595 - 48 - imgWPt
              : spec.align === 'center'
                ? (595 - imgWPt) / 2
                : pdfLayout.content_x || 56;
          pageImages.push({
            x: imageX,
            y: cursorY,
            width: imgWPt,
            height: imgH,
            path: absoluteImage,
          });
          cursorY += imgH + 6;
          if (spec.caption) {
            elements.push({
              type: 'text',
              x: pdfLayout.content_x || 56,
              y: cursorY,
              text: String(spec.caption),
              fontSize: Math.max((pdfLayout.body_font_size || 10) - 1, 8),
              color: mutedRgb,
            });
            cursorY += pdfLayout.line_height || 16;
          }
        }
      } catch {
        // Out-of-repo image paths are dropped, same rule as elsewhere.
      }
    }
  }

  return cursorY;
}
