/** Structured-content slide body builder — extracted from
 * `media-layout-runtime.ts` (file-length policy). Consumes the normalized
 * `StructuredSectionModel` (see `media-structured-content.ts`) and emits
 * pptx element descriptors. Context `ctx` carries resolved theme tokens:
 * surfaceBg/borderHex/primaryHex/accentHex, headingFont/bodyFont,
 * subTextColor/bodyTextColor, spacing, typography.
 */
import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { resolveSlideTemplate } from './media-layout-catalog.js';
import { normalizeStructuredSection } from './media-structured-content.js';

export function buildStructuredSlideBody(data: any, ctx: any): any[] | null {
  const { bodyX, bodyY, bodyW, bodyH } = ctx;
  // Design tokens: components read the theme's 8-pt-grid spacing scale and
  // typography ramp when the active theme declares them; the literals below
  // are the same grid expressed as fallback defaults.
  const sp = (key: string, fallback: number) => Number(ctx.spacing?.[key] ?? fallback);
  const tp = (key: string, fallback: number) => Number(ctx.typography?.[key] ?? fallback);
  const sm = normalizeStructuredSection(data);
  const wbs = sm.wbs;
  const timeline = sm.timeline;
  const matrix = sm.matrix;
  const processFlow = sm.process;
  const org = sm.org;
  const pyramid = sm.pyramid;
  const flow = sm.flow;
  const roadmap = sm.roadmap;
  const kpiTable = sm.kpiTable;
  const table = sm.table ?? sm.tables[0] ?? null;
  const metrics = sm.metrics;
  const steps = sm.steps;
  const columns = sm.columns;
  const checklist = sm.checklist;
  const quote = sm.quote;
  const image = sm.image;
  const hasStructured =
    Boolean(table) ||
    sm.tables.length > 0 ||
    wbs.length > 0 ||
    timeline.length > 0 ||
    Boolean(matrix) ||
    processFlow.length > 0 ||
    org.length > 0 ||
    pyramid.length > 0 ||
    flow.length > 0 ||
    roadmap.length > 0 ||
    kpiTable.length > 0 ||
    metrics.length > 0 ||
    steps.length > 0 ||
    columns.length > 0 ||
    checklist.length > 0 ||
    Boolean(quote?.text) ||
    Boolean(image?.path);
  if (!hasStructured) return null;

  const elements: any[] = [];
  const lead = ctx.bodyLines.length > 0 ? String(ctx.bodyLines[0]) : '';
  const leadH = lead ? sp('xxxl', 0.5) + sp('xxs', 0.05) : 0;
  if (lead) {
    elements.push({
      type: 'text',
      placeholderType: 'body',
      pos: { x: bodyX, y: bodyY, w: bodyW, h: sp('xxxl', 0.45) },
      text: resolveSlideTemplate(lead, data, lead),
      style: {
        fontSize: tp('body', 12),
        color: ctx.subTextColor,
        fontFamily: ctx.bodyFont,
        align: 'left',
        valign: 'top',
      },
    });
  }
  const contentY = bodyY + leadH + sp('md', 0.15);
  const contentH = bodyH - leadH - sp('md', 0.15);

  if (table) {
    elements.push({
      type: 'table',
      pos: { x: bodyX, y: contentY, w: bodyW, h: contentH },
      rows: [...(table.columns.length > 0 ? [table.columns] : []), ...table.rows],
      ...(table.colWidths ? { colWidths: table.colWidths } : {}),
    });
  }

  if (wbs.length > 0) {
    // Hierarchical work breakdown — level-1 tasks get an accent marker and
    // bold face, deeper levels indent with a tree connector.
    const rowH = Math.min(0.4, contentH / Math.max(wbs.length, 8));
    const indentStep = sp('xl', 0.3);
    wbs.slice(0, 20).forEach((entry, i) => {
      const y = contentY + i * rowH;
      const level = Math.min(entry.level, 4);
      if (level === 1) {
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: bodyX, y: y + rowH * 0.25, w: sp('xs', 0.08), h: rowH * 0.5 },
          style: { fill: ctx.accentHex, color: ctx.accentHex },
          text: '',
        });
      }
      elements.push({
        type: 'text',
        pos: {
          x: bodyX + sp('sm', 0.14) + (level - 1) * indentStep,
          y,
          w: bodyW - sp('sm', 0.14) - (level - 1) * indentStep,
          h: rowH,
        },
        text: (level === 1 ? '' : level === 2 ? '├ ' : '└ ') + entry.label,
        style: {
          fontSize: level === 1 ? tp('label', 12) : tp('body', 11),
          bold: level === 1,
          color: level === 1 ? ctx.primaryHex : ctx.bodyTextColor,
          fontFamily: level === 1 ? ctx.headingFont : ctx.bodyFont,
          align: 'left',
          valign: 'middle',
        },
      });
    });
  }

  if (timeline.length > 0) {
    // Date-ranged entries → proportional bars on a shared scale (mini-Gantt).
    // Date-free entries → milestone dots on a horizontal track.
    const toOrdinal = (s: string): number | null => {
      const m = /^(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/.exec(String(s).trim());
      if (!m) return null;
      return Number(m[1]) + (Number(m[2] || 1) - 1) / 12 + (Number(m[3] || 1) - 1) / 365;
    };
    const ranged = timeline.every((e) => toOrdinal(e.start) !== null);
    if (ranged && timeline.length > 0) {
      const lo = Math.min(...timeline.map((e) => toOrdinal(e.start)!));
      const hi = Math.max(...timeline.map((e) => toOrdinal(e.end || e.start)!), lo + 0.001);
      const labelW = Math.min(2.3, bodyW * 0.28);
      const trackX = bodyX + labelW + sp('md', 0.15);
      const trackW = bodyW - labelW - sp('md', 0.15);
      const rowH = Math.min(0.52, contentH / Math.max(timeline.length, 5));
      timeline.slice(0, 10).forEach((entry, i) => {
        const y = contentY + i * rowH;
        elements.push({
          type: 'text',
          pos: { x: bodyX, y, w: labelW, h: rowH },
          text: entry.label + (entry.owner ? `（${entry.owner}）` : ''),
          style: {
            fontSize: tp('body', 11),
            color: ctx.bodyTextColor,
            fontFamily: ctx.bodyFont,
            align: 'left',
            valign: 'middle',
          },
        });
        const s = toOrdinal(entry.start)!;
        const e = Math.max(toOrdinal(entry.end || entry.start)!, s + 0.02);
        const bx = trackX + ((s - lo) / (hi - lo)) * trackW;
        const bw = Math.max(0.25, ((e - s) / (hi - lo)) * trackW);
        elements.push({
          type: 'shape',
          shapeType: 'roundRect',
          pos: { x: bx, y: y + rowH * 0.28, w: bw, h: rowH * 0.4 },
          style: {
            fill: i === timeline.length - 1 ? ctx.accentHex : ctx.primaryHex,
            color: ctx.primaryHex,
            adj: 50000,
          },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: { x: bx, y: y + rowH * 0.28, w: bw, h: rowH * 0.4 },
          text: entry.end ? `${entry.start}–${entry.end}` : entry.start,
          style: {
            fontSize: tp('caption', 9),
            color: 'FFFFFF',
            fontFamily: ctx.bodyFont,
            align: 'center',
            valign: 'middle',
          },
        });
      });
    } else {
      // Milestone track
      const count = timeline.length;
      const trackY = contentY + contentH * 0.5;
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x: bodyX, y: trackY, w: bodyW, h: 0.02 },
        style: { fill: ctx.borderHex || ctx.primaryHex, color: ctx.borderHex || ctx.primaryHex },
        text: '',
      });
      timeline.slice(0, 8).forEach((entry, i) => {
        const x = bodyX + (bodyW / Math.max(count, 1)) * i + sp('md', 0.15);
        const above = i % 2 === 0;
        elements.push({
          type: 'shape',
          shapeType: 'ellipse',
          pos: { x: x - 0.07, y: trackY - 0.06, w: 0.14, h: 0.14 },
          style: { fill: ctx.accentHex, color: ctx.accentHex },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: { x: x - 0.6, y: above ? trackY - 0.85 : trackY + 0.2, w: 1.3, h: 0.3 },
          text: entry.start || entry.end,
          style: {
            fontSize: tp('caption', 9),
            color: ctx.subTextColor,
            fontFamily: ctx.bodyFont,
            align: 'left',
            valign: 'middle',
          },
        });
        elements.push({
          type: 'text',
          pos: { x: x - 0.6, y: above ? trackY - 0.55 : trackY + 0.5, w: 1.3, h: 0.45 },
          text: entry.label,
          style: {
            fontSize: tp('body', 11),
            bold: true,
            color: ctx.bodyTextColor,
            fontFamily: ctx.bodyFont,
            align: 'left',
            valign: 'top',
          },
        });
      });
    }
  }

  if (matrix) {
    // 2×2 quadrant grid with optional axis captions.
    const axisPad = matrix.yAxis ? sp('lg', 0.3) : 0;
    const gridX = bodyX + axisPad;
    const gridW = bodyW - axisPad;
    const gridH = matrix.xAxis ? contentH - sp('lg', 0.3) : contentH;
    const cellW = (gridW - sp('xs', 0.1)) / 2;
    const cellH = (gridH - sp('xs', 0.1)) / 2;
    matrix.quadrants.forEach((q, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = gridX + col * (cellW + sp('xs', 0.1));
      const y = contentY + row * (cellH + sp('xs', 0.1));
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        pos: { x, y, w: cellW, h: cellH },
        style: { fill: ctx.surfaceBg, color: ctx.surfaceBg, adj: 6000 },
        text: '',
      });
      if (q.title) {
        elements.push({
          type: 'text',
          pos: { x: x + sp('md', 0.16), y: y + sp('sm', 0.1), w: cellW - 0.3, h: 0.32 },
          text: q.title,
          style: {
            fontSize: tp('label', 12),
            bold: true,
            color: ctx.primaryHex,
            fontFamily: ctx.headingFont,
            align: 'left',
            valign: 'middle',
          },
        });
      }
      const itemsText = q.items.map((item) => `• ${item}`).join('\n');
      elements.push({
        type: 'text',
        pos: {
          x: x + sp('md', 0.16),
          y: y + (q.title ? sp('xxl', 0.42) : sp('sm', 0.12)),
          w: cellW - 0.3,
          h: cellH - (q.title ? sp('xxl', 0.42) : 0) - 0.1,
        },
        text: itemsText,
        style: {
          fontSize: tp('body', 11),
          color: ctx.bodyTextColor,
          fontFamily: ctx.bodyFont,
          align: 'left',
          valign: 'top',
          lineSpacingPct: 140,
        },
      });
    });
    if (matrix.xAxis) {
      elements.push({
        type: 'text',
        pos: { x: gridX, y: contentY + gridH, w: gridW, h: sp('lg', 0.3) },
        text: matrix.xAxis,
        style: {
          fontSize: tp('caption', 10),
          color: ctx.subTextColor,
          fontFamily: ctx.bodyFont,
          align: 'center',
          valign: 'middle',
        },
      });
    }
    if (matrix.yAxis) {
      elements.push({
        type: 'text',
        pos: { x: bodyX, y: contentY, w: axisPad, h: gridH },
        text: matrix.yAxis,
        style: {
          fontSize: tp('caption', 10),
          color: ctx.subTextColor,
          fontFamily: ctx.bodyFont,
          align: 'center',
          valign: 'middle',
          rotate: -90,
        },
      });
    }
  }

  if (processFlow.length > 0) {
    // Flow: boxes joined by arrows — horizontal when ≤4 steps fit,
    // vertical two-column otherwise.
    const count = Math.min(processFlow.length, 6);
    const horizontal = count <= 4;
    if (horizontal) {
      const arrowW = sp('xl', 0.3);
      const boxW = (bodyW - (count - 1) * arrowW) / count;
      const boxH = Math.min(0.9, contentH * 0.4);
      const y = contentY + contentH * 0.2;
      processFlow.slice(0, count).forEach((step, i) => {
        const x = bodyX + i * (boxW + arrowW);
        elements.push({
          type: 'shape',
          shapeType: 'roundRect',
          pos: { x, y, w: boxW, h: boxH },
          style: { fill: ctx.surfaceBg, color: ctx.borderHex || ctx.primaryHex, adj: 8000 },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: { x: x + sp('xs', 0.1), y, w: boxW - sp('md', 0.2), h: boxH },
          text: step.label,
          style: {
            fontSize: tp('body', 12),
            bold: true,
            color: ctx.primaryHex,
            fontFamily: ctx.headingFont,
            align: 'center',
            valign: 'middle',
          },
        });
        if (step.description) {
          elements.push({
            type: 'text',
            pos: { x, y: y + boxH + sp('xs', 0.08), w: boxW, h: 0.5 },
            text: step.description,
            style: {
              fontSize: tp('caption', 10),
              color: ctx.subTextColor,
              fontFamily: ctx.bodyFont,
              align: 'center',
              valign: 'top',
            },
          });
        }
        if (i < count - 1) {
          elements.push({
            type: 'text',
            pos: { x: x + boxW, y, w: arrowW, h: boxH },
            text: '→',
            style: {
              fontSize: tp('title', 18),
              bold: true,
              color: ctx.accentHex,
              fontFamily: ctx.bodyFont,
              align: 'center',
              valign: 'middle',
            },
          });
        }
      });
    } else {
      const boxH = Math.min(0.62, contentH / count - 0.12);
      const boxW = Math.min(4.2, bodyW * 0.6);
      const x = bodyX + (bodyW - boxW) / 2;
      processFlow.slice(0, count).forEach((step, i) => {
        const y = contentY + i * (boxH + sp('sm', 0.1));
        elements.push({
          type: 'shape',
          shapeType: 'roundRect',
          pos: { x, y, w: boxW, h: boxH },
          style: { fill: ctx.surfaceBg, color: ctx.borderHex || ctx.primaryHex, adj: 8000 },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: { x, y, w: boxW, h: boxH },
          text: step.description ? `${step.label} — ${step.description}` : step.label,
          style: {
            fontSize: tp('body', 11),
            color: ctx.bodyTextColor,
            fontFamily: ctx.bodyFont,
            align: 'center',
            valign: 'middle',
          },
        });
        if (i < count - 1) {
          elements.push({
            type: 'text',
            pos: { x, y: y + boxH - 0.06, w: boxW, h: sp('md', 0.16) },
            text: '↓',
            style: {
              fontSize: tp('label', 12),
              bold: true,
              color: ctx.accentHex,
              fontFamily: ctx.bodyFont,
              align: 'center',
              valign: 'middle',
            },
          });
        }
      });
    }
  }

  if (org.length > 0) {
    // Org chart: level rows centered; children share the parent's row width.
    const levels = Math.max(...org.map((e) => e.level));
    const levelH = Math.min(0.75, contentH / Math.max(levels, 2));
    const gapL = sp('md', 0.15);
    const byLevel: Array<Array<(typeof org)[number]>> = Array.from({ length: levels }, () => []);
    org.slice(0, 18).forEach((e) => byLevel[e.level - 1].push(e));
    const centers = new Map<number, number>();
    byLevel.forEach((members, li) => {
      if (members.length === 0) return;
      const y = contentY + li * levelH;
      const countL = members.length;
      const memberW =
        li === 0
          ? Math.min(2.4, bodyW * 0.4)
          : Math.min(2.0, (bodyW - (countL - 1) * gapL) / countL);
      const rowW = countL * memberW + (countL - 1) * gapL;
      const startX = bodyX + (bodyW - rowW) / 2;
      members.forEach((member, mi) => {
        const x = startX + mi * (memberW + gapL);
        centers.set(member.index, x + memberW / 2);
        // connector from parent — elbow: drop from parent bottom, across the
        // junction, then down into the child box top.
        if (member.parent >= 0 && centers.has(member.parent)) {
          const px = centers.get(member.parent)!;
          const cx = x + memberW / 2;
          const gapTop = y - sp('xs', 0.1);
          const junctionY = gapTop + sp('xxs', 0.04);
          const stroke = ctx.borderHex || ctx.subTextColor;
          elements.push({
            type: 'shape',
            shapeType: 'rect',
            pos: {
              x: px - 0.008,
              y: gapTop - sp('xxs', 0.02),
              w: 0.016,
              h: junctionY - gapTop + 0.06,
            },
            style: { fill: stroke, color: stroke },
            text: '',
          });
          elements.push({
            type: 'shape',
            shapeType: 'rect',
            pos: {
              x: Math.min(px, cx),
              y: junctionY,
              w: Math.max(0.02, Math.abs(cx - px)),
              h: 0.014,
            },
            style: { fill: stroke, color: stroke },
            text: '',
          });
          elements.push({
            type: 'shape',
            shapeType: 'rect',
            pos: { x: cx - 0.008, y: junctionY, w: 0.016, h: y - junctionY },
            style: { fill: stroke, color: stroke },
            text: '',
          });
        }
        elements.push({
          type: 'shape',
          shapeType: 'roundRect',
          pos: { x, y, w: memberW, h: levelH - sp('xs', 0.1) },
          style: {
            fill: li === 0 ? ctx.primaryHex : ctx.surfaceBg,
            color: ctx.borderHex || ctx.primaryHex,
            adj: 9000,
          },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: {
            x: x + sp('xs', 0.06),
            y: y + sp('xxs', 0.04),
            w: memberW - sp('sm', 0.12),
            h: (levelH - sp('xs', 0.1)) * (member.role ? 0.62 : 1),
          },
          text: member.name,
          style: {
            fontSize: tp('body', 11),
            bold: true,
            color: li === 0 ? 'FFFFFF' : ctx.primaryHex,
            fontFamily: ctx.headingFont,
            align: 'center',
            valign: 'middle',
          },
        });
        if (member.role) {
          elements.push({
            type: 'text',
            pos: {
              x: x + sp('xs', 0.06),
              y: y + (levelH - sp('xs', 0.1)) * 0.6,
              w: memberW - sp('sm', 0.12),
              h: (levelH - sp('xs', 0.1)) * 0.35,
            },
            text: member.role,
            style: {
              fontSize: tp('caption', 9),
              color: li === 0 ? 'FFFFFF' : ctx.subTextColor,
              fontFamily: ctx.bodyFont,
              align: 'center',
              valign: 'top',
            },
          });
        }
      });
    });
  }

  if (pyramid.length > 0) {
    // Stacked horizontal bands — apex narrow, base wide.
    const count = pyramid.length;
    const bandH = Math.min(0.72, contentH / count - sp('xs', 0.06));
    const narrowest = bodyW * 0.34;
    pyramid.forEach((entry, i) => {
      const w = narrowest + (bodyW - narrowest) * (i / Math.max(count - 1, 1));
      const x = bodyX + (bodyW - w) / 2;
      const y = contentY + i * (bandH + sp('xs', 0.06));
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        pos: { x, y, w, h: bandH },
        style: {
          fill: i === 0 ? ctx.primaryHex : i === count - 1 ? ctx.accentHex : ctx.surfaceBg,
          color: ctx.borderHex || ctx.primaryHex,
          adj: 6000,
        },
        text: '',
      });
      elements.push({
        type: 'text',
        pos: { x, y, w, h: bandH },
        text: entry.description ? `${entry.label} — ${entry.description}` : entry.label,
        style: {
          fontSize: tp('body', 11),
          bold: i === 0 || i === count - 1,
          color: i === 0 || i === count - 1 ? 'FFFFFF' : ctx.bodyTextColor,
          fontFamily: ctx.bodyFont,
          align: 'center',
          valign: 'middle',
        },
      });
    });
  }

  if (flow.length > 0) {
    // Swimlanes — one row per lane, steps as connected boxes.
    const laneLabelW = Math.min(1.6, bodyW * 0.18);
    const laneW = bodyW - laneLabelW - sp('sm', 0.1);
    const laneH = Math.min(0.95, contentH / Math.max(flow.length, 2) - sp('xs', 0.08));
    flow.slice(0, 5).forEach((lane, li) => {
      const y = contentY + li * (laneH + sp('xs', 0.08));
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x: bodyX, y, w: laneLabelW, h: laneH },
        style: { fill: ctx.primaryHex, color: ctx.primaryHex },
        text: lane.lane,
        textStyle: {
          fontSize: tp('label', 11),
          bold: true,
          color: 'FFFFFF',
          fontFamily: ctx.headingFont,
          align: 'center',
          valign: 'middle',
        },
      });
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x: bodyX + laneLabelW, y, w: laneW + sp('sm', 0.1), h: laneH },
        style: { fill: ctx.surfaceBg, color: ctx.surfaceBg },
        text: '',
      });
      const stepCount = Math.min(lane.steps.length, 5);
      const arrowW = sp('lg', 0.24);
      const stepW = (laneW - (stepCount - 1) * arrowW) / stepCount;
      lane.steps.slice(0, stepCount).forEach((step, si) => {
        const sx = bodyX + laneLabelW + sp('xs', 0.08) + si * (stepW + arrowW);
        const sy = y + sp('xs', 0.1);
        const sh = laneH - sp('md', 0.2);
        elements.push({
          type: 'shape',
          shapeType: 'roundRect',
          pos: { x: sx, y: sy, w: stepW, h: sh },
          style: { fill: 'FFFFFF', color: ctx.borderHex || ctx.primaryHex, adj: 8000 },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: { x: sx + sp('xxs', 0.04), y: sy, w: stepW - sp('xs', 0.08), h: sh },
          text: step.label,
          style: {
            fontSize: tp('caption', 10),
            bold: true,
            color: ctx.bodyTextColor,
            fontFamily: ctx.bodyFont,
            align: 'center',
            valign: 'middle',
          },
        });
        if (si < stepCount - 1) {
          elements.push({
            type: 'text',
            pos: { x: sx + stepW, y: sy, w: arrowW, h: sh },
            text: '→',
            style: {
              fontSize: tp('label', 13),
              bold: true,
              color: ctx.accentHex,
              fontFamily: ctx.bodyFont,
              align: 'center',
              valign: 'middle',
            },
          });
        }
      });
    });
  }

  if (roadmap.length > 0) {
    // Period cards — quarter/phase columns with items underneath.
    const count = Math.min(roadmap.length, 5);
    const gap = sp('md', 0.15);
    const cardW = (bodyW - (count - 1) * gap) / count;
    roadmap.slice(0, count).forEach((period, i) => {
      const x = bodyX + i * (cardW + gap);
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        pos: { x, y: contentY, w: cardW, h: contentH },
        style: { fill: ctx.surfaceBg, color: ctx.surfaceBg, adj: 5000 },
        text: '',
      });
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x, y: contentY, w: cardW, h: sp('xxl', 0.4) },
        style: { fill: i === count - 1 ? ctx.accentHex : ctx.primaryHex, color: ctx.primaryHex },
        text: period.period || period.title,
        textStyle: {
          fontSize: tp('label', 12),
          bold: true,
          color: 'FFFFFF',
          fontFamily: ctx.headingFont,
          align: 'center',
          valign: 'middle',
        },
      });
      if (period.title && period.period) {
        elements.push({
          type: 'text',
          pos: {
            x: x + sp('sm', 0.1),
            y: contentY + sp('xxl', 0.4) + sp('xs', 0.06),
            w: cardW - 0.2,
            h: 0.3,
          },
          text: period.title,
          style: {
            fontSize: tp('label', 12),
            bold: true,
            color: ctx.primaryHex,
            fontFamily: ctx.headingFont,
            align: 'left',
            valign: 'middle',
          },
        });
      }
      const itemsText = period.items.map((item) => `• ${item}`).join('\n');
      if (itemsText) {
        elements.push({
          type: 'text',
          pos: {
            x: x + sp('sm', 0.1),
            y: contentY + sp('xxl', 0.42) + (period.title ? sp('xxl', 0.4) : sp('xs', 0.08)),
            w: cardW - 0.22,
            h: contentH - sp('xxl', 0.8),
          },
          text: itemsText,
          style: {
            fontSize: tp('body', 10.5),
            color: ctx.bodyTextColor,
            fontFamily: ctx.bodyFont,
            align: 'left',
            valign: 'top',
            lineSpacingPct: 140,
          },
        });
      }
    });
  }

  if (kpiTable.length > 0) {
    // KPI table — metric label left, big value, target/delta right-aligned.
    const rowH = Math.min(0.52, contentH / Math.max(kpiTable.length, 3));
    kpiTable.slice(0, 8).forEach((entry, i) => {
      const y = contentY + i * rowH;
      if (i % 2 === 1) {
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: bodyX, y, w: bodyW, h: rowH },
          style: { fill: ctx.surfaceBg, color: ctx.surfaceBg },
          text: '',
        });
      }
      elements.push({
        type: 'text',
        pos: { x: bodyX + sp('sm', 0.1), y, w: bodyW * 0.38, h: rowH },
        text: entry.metric,
        style: {
          fontSize: tp('body', 12),
          color: ctx.bodyTextColor,
          fontFamily: ctx.bodyFont,
          align: 'left',
          valign: 'middle',
        },
      });
      elements.push({
        type: 'text',
        pos: { x: bodyX + bodyW * 0.38, y, w: bodyW * 0.22, h: rowH },
        text: entry.value,
        style: {
          fontSize: tp('title', 16),
          bold: true,
          color: ctx.primaryHex,
          fontFamily: ctx.headingFont,
          align: 'right',
          valign: 'middle',
        },
      });
      elements.push({
        type: 'text',
        pos: { x: bodyX + bodyW * 0.62, y, w: bodyW * 0.18, h: rowH },
        text: entry.target ? `目標 ${entry.target}` : '',
        style: {
          fontSize: tp('caption', 10),
          color: ctx.subTextColor,
          fontFamily: ctx.bodyFont,
          align: 'right',
          valign: 'middle',
        },
      });
      const deltaText = [entry.delta, entry.trend].filter(Boolean).join(' ');
      if (deltaText) {
        elements.push({
          type: 'text',
          pos: { x: bodyX + bodyW * 0.8, y, w: bodyW * 0.2, h: rowH },
          text: deltaText,
          style: {
            fontSize: tp('caption', 10),
            bold: true,
            color: /^[+↑▲]/.test(deltaText.trim()) ? ctx.accentHex : ctx.subTextColor,
            fontFamily: ctx.bodyFont,
            align: 'right',
            valign: 'middle',
          },
        });
      }
    });
  }

  if (metrics.length > 0) {
    const count = Math.min(metrics.length, 4);
    if (count === 1) {
      // Spotlight: a single metric reads best held as one large card.
      const cardW = Math.min(4.6, bodyW * 0.55);
      const cardH = Math.min(2.3, contentH * 0.85);
      const x = bodyX + (bodyW - cardW) / 2;
      const y = contentY + (contentH - cardH) / 2;
      const metric = metrics[0];
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        pos: { x, y, w: cardW, h: cardH },
        style: { fill: ctx.surfaceBg, color: ctx.surfaceBg, adj: 8000 },
        text: '',
      });
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x, y, w: cardW, h: sp('xs', 0.08) },
        style: { fill: ctx.accentHex, color: ctx.accentHex },
        text: '',
      });
      elements.push({
        type: 'text',
        pos: { x, y: y + cardH * 0.2, w: cardW, h: cardH * 0.45 },
        text: metric.value,
        style: {
          fontSize: tp('display', 40),
          bold: true,
          color: ctx.primaryHex,
          fontFamily: ctx.headingFont,
          align: 'center',
          valign: 'middle',
        },
      });
      elements.push({
        type: 'text',
        pos: { x, y: y + cardH * 0.68, w: cardW, h: cardH * 0.24 },
        text: metric.label,
        style: {
          fontSize: tp('label', 12),
          color: ctx.subTextColor,
          fontFamily: ctx.bodyFont,
          align: 'center',
          valign: 'top',
        },
      });
    } else {
      const gap = sp('md', 0.17);
      const cardW = (bodyW - (count - 1) * gap) / count;
      const cardH = Math.min(1.7, contentH * 0.85);
      metrics.slice(0, count).forEach((metric, i) => {
        const x = bodyX + i * (cardW + gap);
        const y = contentY + (contentH - cardH) / 2;
        elements.push({
          type: 'shape',
          shapeType: 'roundRect',
          pos: { x, y, w: cardW, h: cardH },
          style: { fill: ctx.surfaceBg, color: ctx.surfaceBg, adj: 8000 },
          text: '',
        });
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: x + sp('sm', 0.12), y: y + sp('md', 0.15), w: 0.05, h: cardH - sp('lg', 0.3) },
          style: { fill: ctx.accentHex, color: ctx.accentHex },
          text: '',
        });
        elements.push({
          type: 'text',
          pos: { x: x + sp('lg', 0.28), y: y + sp('sm', 0.12), w: cardW - 0.4, h: cardH * 0.52 },
          text: metric.value,
          style: {
            fontSize: tp('headline', 28),
            bold: true,
            color: ctx.primaryHex,
            fontFamily: ctx.headingFont,
            align: 'left',
            valign: 'middle',
          },
        });
        elements.push({
          type: 'text',
          pos: { x: x + sp('lg', 0.28), y: y + cardH * 0.6, w: cardW - 0.4, h: cardH * 0.32 },
          text: metric.label,
          style: {
            fontSize: tp('label', 11),
            color: ctx.subTextColor,
            fontFamily: ctx.bodyFont,
            align: 'left',
            valign: 'top',
          },
        });
      });
    }
  }

  if (steps.length > 0) {
    const count = Math.min(steps.length, 6);
    const overlap = sp('lg', 0.25);
    const stepW = (bodyW + (count - 1) * overlap) / count;
    const chevronH = 0.72;
    const y = contentY + 0.25;
    steps.slice(0, count).forEach((step, i) => {
      const x = bodyX + i * (stepW - overlap);
      const isLast = i === count - 1;
      elements.push({
        type: 'shape',
        shapeType: 'chevron',
        pos: { x, y, w: stepW, h: chevronH },
        style: { fill: isLast ? ctx.accentHex : ctx.primaryHex, color: ctx.primaryHex },
        text: step.title,
        textStyle: {
          fontSize: tp('body', 12),
          bold: true,
          color: 'FFFFFF',
          fontFamily: ctx.headingFont,
          align: 'center',
          valign: 'middle',
        },
      });
      if (step.description) {
        elements.push({
          type: 'text',
          pos: { x, y: y + chevronH + sp('xs', 0.08), w: stepW - overlap, h: 0.75 },
          text: step.description,
          style: {
            fontSize: tp('caption', 10),
            color: ctx.subTextColor,
            fontFamily: ctx.bodyFont,
            align: 'left',
            valign: 'top',
          },
        });
      }
    });
  }

  if (columns.length > 0) {
    const gap = sp('lg', 0.25);
    const colW = (bodyW - (columns.length - 1) * gap) / columns.length;
    columns.forEach((column, i) => {
      const x = bodyX + i * (colW + gap);
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        pos: { x, y: contentY, w: colW, h: contentH },
        style: { fill: ctx.surfaceBg, color: ctx.surfaceBg, adj: 6000 },
        text: '',
      });
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x, y: contentY, w: colW, h: sp('xxl', 0.42) },
        style: { fill: ctx.primaryHex, color: ctx.primaryHex },
        text: '',
      });
      elements.push({
        type: 'text',
        pos: { x: x + sp('md', 0.15), y: contentY, w: colW - 0.3, h: sp('xxl', 0.42) },
        text: column.title,
        style: {
          fontSize: tp('label', 13),
          bold: true,
          color: 'FFFFFF',
          fontFamily: ctx.headingFont,
          align: 'left',
          valign: 'middle',
        },
      });
      const itemsText = column.items.map((item) => `• ${item}`).join('\n');
      elements.push({
        type: 'text',
        pos: {
          x: x + sp('md', 0.17),
          y: contentY + sp('xxl', 0.42) + sp('sm', 0.13),
          w: colW - 0.35,
          h: contentH - sp('xxl', 0.42) - sp('md', 0.25),
        },
        text: itemsText,
        style: {
          fontSize: tp('body', 12),
          color: ctx.bodyTextColor,
          fontFamily: ctx.bodyFont,
          align: 'left',
          valign: 'top',
          lineSpacingPct: 155,
        },
      });
    });
  }

  if (checklist.length > 0) {
    const perCol = Math.ceil(checklist.length / 2);
    const colW = (bodyW - sp('lg', 0.3)) / 2;
    const rowH = Math.min(0.52, (contentH - 0.2) / perCol);
    checklist.forEach((item, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      const x = bodyX + col * (colW + sp('lg', 0.3));
      const y = contentY + row * (rowH + sp('sm', 0.12));
      elements.push({
        type: 'shape',
        shapeType: 'roundRect',
        pos: { x, y, w: colW, h: rowH },
        style: { fill: ctx.surfaceBg, color: ctx.surfaceBg, adj: 12000 },
        text: '',
      });
      elements.push({
        type: 'text',
        pos: { x: x + sp('sm', 0.12), y, w: colW - sp('lg', 0.24), h: rowH },
        text: `${item.done ? '☑' : '✓'} ${item.text}`,
        style: {
          fontSize: tp('body', 12),
          color: ctx.bodyTextColor,
          fontFamily: ctx.bodyFont,
          align: 'left',
          valign: 'middle',
        },
      });
    });
  }

  if (quote?.text) {
    const quoteY = contentY + contentH * 0.15;
    const quoteH = contentH * 0.55;
    elements.push({
      type: 'text',
      pos: { x: bodyX, y: quoteY - sp('md', 0.15), w: sp('xxxl', 0.55), h: 0.6 },
      text: '「',
      style: {
        fontSize: tp('display', 36),
        bold: true,
        color: ctx.accentHex,
        fontFamily: ctx.headingFont,
        align: 'left',
        valign: 'top',
      },
    });
    elements.push({
      type: 'text',
      pos: {
        x: bodyX + sp('xxxl', 0.5) + sp('sm', 0.12),
        y: quoteY,
        w: bodyW - 2 * (sp('xxxl', 0.5) + sp('sm', 0.12)),
        h: quoteH,
      },
      text: resolveSlideTemplate(quote.text, data, quote.text),
      style: {
        fontSize: tp('title', 20),
        bold: true,
        color: ctx.bodyTextColor,
        fontFamily: ctx.headingFont,
        align: 'center',
        valign: 'middle',
        lineSpacingPct: 150,
      },
    });
    if (quote.attribution) {
      elements.push({
        type: 'text',
        pos: {
          x: bodyX + sp('xxxl', 0.5) + sp('sm', 0.12),
          y: quoteY + quoteH + sp('xs', 0.1),
          w: bodyW - 2 * (sp('xxxl', 0.5) + sp('sm', 0.12)),
          h: 0.4,
        },
        text: `— ${quote.attribution}`,
        style: {
          fontSize: tp('label', 11),
          color: ctx.subTextColor,
          fontFamily: ctx.bodyFont,
          align: 'right',
          valign: 'top',
        },
      });
    }
  }

  if (image?.path && ctx.rootDir) {
    try {
      const imagePath = assertSafeRepositoryPath(path.resolve(ctx.rootDir, image.path), {
        allowMissingLeaf: true,
      });
      if (safeExistsSync(imagePath)) {
        const imgW = lead ? bodyW * 0.55 : Math.min(bodyW * 0.75, contentH * 1.6);
        const imgH = Math.min(contentH * 0.85, imgW * 0.66);
        const imgX = bodyX + (bodyW - imgW) / 2;
        const imgY = contentY + (contentH - imgH - (image.caption ? 0.35 : 0)) / 2;
        elements.push({
          type: 'image',
          imagePath,
          pos: { x: imgX, y: imgY, w: imgW, h: imgH },
        });
        if (image.caption) {
          elements.push({
            type: 'text',
            pos: { x: imgX, y: imgY + imgH + sp('xxs', 0.05), w: imgW, h: 0.3 },
            text: image.caption,
            style: {
              fontSize: tp('caption', 10),
              color: ctx.subTextColor,
              fontFamily: ctx.bodyFont,
              align: 'center',
              valign: 'top',
            },
          });
        }
      }
    } catch {
      // Image paths that escape the repo are dropped, same as logo handling.
    }
  }

  return elements;
}
