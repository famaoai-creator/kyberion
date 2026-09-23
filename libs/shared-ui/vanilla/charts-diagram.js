/*
 * Kyberion UI — chart layout: ui:sequence and ui:flow layouts.
 *
 * Part of the renderer-independent chart layout re-exported by `charts.js`
 * (see its header for the vnode / color / accessibility contract).
 */
import {
  FONT,
  KB_CHART_MESSAGE_KEYS,
  KB_STATUS_GLYPHS,
  KB_TONE_GLYPHS,
  TICK_FONT,
  ariaLabel,
  chartFigure,
  dataTable,
  emptyChart,
  fitText,
  fmtCoord,
  h,
  isRecord,
  statusToneOf,
  str,
  svgRoot,
  textWidth,
  titleOf,
  tooltip,
} from './charts-core.js';
import { layerDag, orderSequence } from './charts-scale.js';

// ---------------------------------------------------------------------------
// ui:sequence
// ---------------------------------------------------------------------------

function statusMark(env, status, x, y, anchor) {
  const tone = statusToneOf(status);
  if (!tone) return null;
  return h(
    'text',
    {
      class: 'kb-chart__status',
      'data-tone': tone,
      'data-status': status,
      x,
      y,
      'text-anchor': anchor,
      'dominant-baseline': 'middle',
    },
    `${KB_STATUS_GLYPHS[status]} ${env.statusLabel(status)}`
  );
}

function arrowHead(x, y, direction) {
  const c = fmtCoord;
  const dx = direction * 7;
  return h('path', {
    class: 'kb-chart__arrowhead',
    d: `M${c(x)} ${c(y)}L${c(x - dx)} ${c(y - 4)}L${c(x - dx)} ${c(y + 4)}Z`,
  });
}

export function layoutSequence(p, env) {
  const { lanes, laneIndex, messages } = orderSequence(
    Array.isArray(p.participants) ? p.participants : [],
    Array.isArray(p.messages) ? p.messages : []
  );
  if (lanes.length === 0 || messages.length === 0) return emptyChart('sequence', p, env);
  const compact = p.density === 'compact';
  const hasAt = messages.some((m) => m.at !== undefined && m.at !== null && m.at !== '');
  const hasStatus = messages.some((m) => statusToneOf(m.status));
  const gutter = hasAt
    ? Math.min(96, Math.max(...messages.map((m) => textWidth(str(m.at), TICK_FONT)))) + 16
    : 8;
  const laneW = 160;
  const headH = 30;
  // A status pill sits below the arrow (y+13) and the next row's label sits
  // above its arrow (y+rowH-9); the base compact row height leaves the two
  // close enough to visually overlap once a status label is present, so rows
  // get extra vertical room whenever any message carries a status.
  const rowH = (compact ? 36 : 46) + (hasStatus ? 10 : 0);
  const top = 8;
  const W = gutter + laneW * lanes.length + 8;
  const firstRow = top + headH + 30;
  const H = firstRow + rowH * (messages.length - 1) + 24;
  const laneX = (id) => gutter + laneW * laneIndex.get(id) + laneW / 2;

  const heads = [];
  const lifelines = [];
  lanes.forEach((lane, i) => {
    const cx = gutter + laneW * i + laneW / 2;
    lifelines.push(
      h('line', { class: 'kb-chart__lifeline', x1: cx, x2: cx, y1: top + headH, y2: H - 4 })
    );
    heads.push(
      h(
        'g',
        { class: 'kb-chart__participant' },
        h('rect', {
          class: 'kb-chart__participant-box',
          x: cx - (laneW - 20) / 2,
          y: top,
          width: laneW - 20,
          height: headH,
          rx: 6,
        }),
        h(
          'text',
          {
            class: 'kb-chart__participant-label',
            x: cx,
            y: top + headH / 2,
            'text-anchor': 'middle',
            'dominant-baseline': 'middle',
          },
          fitText(lane.label, laneW - 32, FONT)
        )
      )
    );
  });

  const rows = [];
  messages.forEach((message, i) => {
    const y = firstRow + rowH * i;
    const x1 = laneX(message.from);
    const x2 = laneX(message.to);
    const kind = message.kind === 'reply' || message.kind === 'note' ? message.kind : 'call';
    const label = str(message.label);
    const tone = statusToneOf(message.status);
    const statusText = tone
      ? `${KB_STATUS_GLYPHS[message.status]} ${env.statusLabel(message.status)}`
      : '';
    const parts = [];
    if (hasAt && message.at !== undefined && message.at !== null && message.at !== '') {
      parts.push(
        h(
          'text',
          {
            class: 'kb-chart__tick kb-chart__time',
            x: gutter - 10,
            y,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
          },
          str(message.at)
        )
      );
    }
    if (x1 === x2) {
      // Self-message: a loop to the right of the lifeline, label beside it.
      const loop = 28;
      const d = `M${fmtCoord(x1)} ${fmtCoord(y - 10)}H${fmtCoord(x1 + loop)}V${fmtCoord(y + 8)}H${fmtCoord(x1 + 8)}`;
      parts.push(h('path', { class: 'kb-chart__message', 'data-kind': kind, d }));
      parts.push(arrowHead(x1 + 1, y + 8, -1));
      const room = laneW - loop - 12;
      parts.push(
        h(
          'text',
          {
            class: 'kb-chart__message-label',
            x: x1 + loop + 6,
            y: y - 10,
            'dominant-baseline': 'middle',
          },
          fitText(label, room, FONT)
        )
      );
      if (statusText) {
        parts.push(statusMark(env, message.status, x1 + loop + 6, y + 6, 'start'));
      }
    } else {
      const dir = x2 > x1 ? 1 : -1;
      const tipX = x2 - dir * 2;
      parts.push(
        h('line', {
          class: 'kb-chart__message',
          'data-kind': kind,
          x1,
          x2: tipX - dir * 6,
          y1: y,
          y2: y,
        })
      );
      parts.push(arrowHead(tipX, y, dir));
      const span = Math.abs(x2 - x1) - 16;
      const midX = (x1 + x2) / 2;
      const labelText = fitText(label, Math.max(24, span), FONT);
      parts.push(
        h(
          'text',
          { class: 'kb-chart__message-label', x: midX, y: y - 9, 'text-anchor': 'middle' },
          labelText
        )
      );
      // Status sits under the arrow so the label keeps the full span.
      if (statusText) parts.push(statusMark(env, message.status, midX, y + 13, 'middle'));
    }
    const tip = `${laneLabel(lanes, laneIndex, message.from)} → ${laneLabel(lanes, laneIndex, message.to)}: ${label}${statusText ? ` (${env.statusLabel(message.status)})` : ''}`;
    rows.push(
      h(
        'g',
        {
          class: 'kb-chart__message-row',
          'data-kind': kind,
          'data-status': message.status || undefined,
        },
        tooltip(tip),
        parts
      )
    );
  });

  const summary = env.t(KB_CHART_MESSAGE_KEYS.summarySequence, {
    messages: messages.length,
    participants: lanes.length,
  });
  const title = titleOf(p);
  const headers = [
    ...(hasAt ? [env.t(KB_CHART_MESSAGE_KEYS.tableTime)] : []),
    env.t(KB_CHART_MESSAGE_KEYS.tableFrom),
    env.t(KB_CHART_MESSAGE_KEYS.tableTo),
    env.t(KB_CHART_MESSAGE_KEYS.tableMessage),
    ...(hasStatus ? [env.t(KB_CHART_MESSAGE_KEYS.tableStatus)] : []),
  ];
  const tableRows = messages.map((m) => [
    ...(hasAt ? [str(m.at) || '—'] : []),
    laneLabel(lanes, laneIndex, m.from),
    laneLabel(lanes, laneIndex, m.to),
    str(m.label),
    ...(hasStatus ? [statusToneOf(m.status) ? env.statusLabel(m.status) : '—'] : []),
  ]);
  if (!hasAt) {
    // First column is a row header; keep it meaningful.
    headers.unshift('#');
    tableRows.forEach((row, i) => row.unshift(String(i + 1)));
  }
  return chartFigure('sequence', p, env, {
    summary,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      'kb-chart__svg--diagram',
      h('g', { class: 'kb-chart__lanes', 'aria-hidden': 'true' }, lifelines, heads),
      h('g', { class: 'kb-chart__marks' }, rows)
    ),
    table: dataTable(title, headers, tableRows),
  });
}

function laneLabel(lanes, laneIndex, id) {
  return laneIndex.has(id) ? lanes[laneIndex.get(id)].label : id;
}

// ---------------------------------------------------------------------------
// ui:flow
// ---------------------------------------------------------------------------

/** Bottom edge (y + height) of the lowest node row across layers `lo..hi` inclusive. */
function layerRowsBottom(layers, pos, nodeH, lo, hi) {
  let bottom = -Infinity;
  for (let l = lo; l <= hi; l++) {
    for (const id of layers[l] || []) {
      const p = pos.get(id);
      if (p) bottom = Math.max(bottom, p.y + nodeH);
    }
  }
  return bottom;
}

/**
 * SVG path through `points` (>= 2), straight segments with rounded corners
 * (radius `r`, clamped to half the shorter adjoining segment).
 */
function roundedPolyline(points, r) {
  const c = fmtCoord;
  let d = `M${c(points[0].x)} ${c(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const d1x = cur.x - prev.x;
    const d1y = cur.y - prev.y;
    const len1 = Math.hypot(d1x, d1y) || 1;
    const d2x = next.x - cur.x;
    const d2y = next.y - cur.y;
    const len2 = Math.hypot(d2x, d2y) || 1;
    const rr = Math.min(r, len1 / 2, len2 / 2);
    const p1 = { x: cur.x - (d1x / len1) * rr, y: cur.y - (d1y / len1) * rr };
    const p2 = { x: cur.x + (d2x / len2) * rr, y: cur.y + (d2y / len2) * rr };
    d += `L${c(p1.x)} ${c(p1.y)}Q${c(cur.x)} ${c(cur.y)} ${c(p2.x)} ${c(p2.y)}`;
  }
  const last = points[points.length - 1];
  d += `L${c(last.x)} ${c(last.y)}`;
  return d;
}

export function layoutFlow(p, env) {
  const nodes = (Array.isArray(p.nodes) ? p.nodes : []).filter(
    (node) => isRecord(node) && typeof node.id === 'string' && node.id
  );
  if (nodes.length === 0) return emptyChart('flow', p, env);
  const edges = (Array.isArray(p.edges) ? p.edges : []).filter(isRecord);
  const stages = Array.isArray(p.stages) ? p.stages : [];
  const { layers, layerOf, stageIds } = layerDag(nodes, edges, stages);
  const byId = new Map();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const stageLabel = new Map();
  for (const stage of stages) {
    if (isRecord(stage) && typeof stage.id === 'string')
      stageLabel.set(stage.id, str(stage.label) || stage.id);
  }
  const compact = p.density === 'compact';
  const nodeW = 168;
  const nodeH = compact ? 42 : 50;
  const colGap = 56;
  const rowGap = compact ? 12 : 18;
  const headH = stageIds.length ? 26 : 0;
  const top = 8 + headH;
  const pitch = nodeH + rowGap;
  const maxRows = Math.max(...layers.map((layer) => layer.length));
  const W = 8 + layers.length * nodeW + (layers.length - 1) * colGap + 8;
  const hasBack = edges.some(
    (edge) =>
      layerOf.has(edge.from) &&
      layerOf.has(edge.to) &&
      edge.from !== edge.to &&
      layerOf.get(edge.to) <= layerOf.get(edge.from)
  );
  const H = top + maxRows * pitch - rowGap + (hasBack ? 36 : 8);
  const pos = new Map();
  layers.forEach((layer, l) => {
    const offset = ((maxRows - layer.length) * pitch) / 2;
    layer.forEach((id, i) => {
      pos.set(id, { x: 8 + l * (nodeW + colGap), y: top + offset + i * pitch });
    });
  });

  const heads = stageIds.map((stage, l) =>
    h(
      'text',
      {
        class: 'kb-chart__stage-label',
        x: 8 + l * (nodeW + colGap) + nodeW / 2,
        y: 8 + headH / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'middle',
      },
      fitText(stageLabel.get(stage) || stage, nodeW + colGap - 12, FONT)
    )
  );

  const validEdges = edges.filter(
    (edge) => pos.has(edge.from) && pos.has(edge.to) && edge.from !== edge.to
  );
  const edgeNodes = [];
  const edgeLabels = [];
  const c = fmtCoord;
  validEdges.forEach((edge) => {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    const forward = layerOf.get(edge.to) > layerOf.get(edge.from);
    let d;
    let tip;
    let mid;
    if (forward) {
      const sx = a.x + nodeW;
      const sy = a.y + nodeH / 2;
      const tx = b.x - 2;
      const ty = b.y + nodeH / 2;
      const bend = Math.max(24, (tx - sx) / 2);
      d = `M${c(sx)} ${c(sy)}C${c(sx + bend)} ${c(sy)} ${c(tx - 8 - bend)} ${c(ty)} ${c(tx - 8)} ${c(ty)}`;
      tip = arrowHead(tx, ty, 1);
      mid = { x: (sx + tx) / 2, y: (sy + ty) / 2 };
    } else if (layerOf.get(edge.from) === layerOf.get(edge.to)) {
      // Same-stage loop: no columns to cross, drop below just this layer.
      const layer = layerOf.get(edge.from);
      const sx = a.x + nodeW / 2;
      const sy = a.y + nodeH;
      const tx = b.x + nodeW / 2;
      const ty = b.y + nodeH + 2;
      const low = layerRowsBottom(layers, pos, nodeH, layer, layer) + 18;
      d = `M${c(sx)} ${c(sy)}C${c(sx)} ${c(low)} ${c(tx)} ${c(low)} ${c(tx)} ${c(ty + 8)}`;
      tip = h('path', {
        class: 'kb-chart__arrowhead',
        d: `M${c(tx)} ${c(ty)}L${c(tx - 4)} ${c(ty + 7)}L${c(tx + 4)} ${c(ty + 7)}Z`,
      });
      mid = { x: (sx + tx) / 2, y: low - 6 };
    } else {
      // Back edge spanning earlier layers: exit/enter the box sides (never
      // straight down through same-column siblings) and detour, in the
      // column gaps, below the lowest node row of every layer it spans —
      // so the edge never passes behind an intermediate node.
      const fromLayer = layerOf.get(edge.from);
      const toLayer = layerOf.get(edge.to);
      const lo = Math.min(fromLayer, toLayer);
      const hi = Math.max(fromLayer, toLayer);
      const low = layerRowsBottom(layers, pos, nodeH, lo, hi) + 18;
      const midYa = a.y + nodeH / 2;
      const midYb = b.y + nodeH / 2;
      const gap = Math.max(10, Math.min(24, colGap / 2 - 4));
      const exitX = a.x - gap;
      const entryStubX = b.x + nodeW + gap;
      const entryTipX = b.x + nodeW + 2;
      d = roundedPolyline(
        [
          { x: a.x, y: midYa },
          { x: exitX, y: midYa },
          { x: exitX, y: low },
          { x: entryStubX, y: low },
          { x: entryStubX, y: midYb },
          { x: entryTipX + 6, y: midYb },
        ],
        8
      );
      tip = arrowHead(entryTipX, midYb, -1);
      mid = { x: (exitX + entryStubX) / 2, y: low - 6 };
    }
    const label = str(edge.label);
    edgeNodes.push(
      h(
        'g',
        { class: 'kb-chart__edge', 'data-direction': forward ? undefined : 'back' },
        tooltip(
          `${str(byId.get(edge.from).label) || edge.from} → ${str(byId.get(edge.to).label) || edge.to}${label ? `: ${label}` : ''}`
        ),
        h('path', { class: 'kb-chart__edge-line', d }),
        tip
      )
    );
    if (label) {
      edgeLabels.push(
        h(
          'text',
          { class: 'kb-chart__edge-label', x: mid.x, y: mid.y - 6, 'text-anchor': 'middle' },
          fitText(label, colGap + 40, TICK_FONT)
        )
      );
    }
  });

  const nodeMarks = [];
  for (const layer of layers) {
    for (const id of layer) {
      const node = byId.get(id);
      const { x, y } = pos.get(id);
      const tone = statusToneOf(node.status);
      const label = str(node.label) || id;
      const sub = tone ? `${KB_TONE_GLYPHS[tone]} ${env.statusLabel(node.status)}` : str(node.meta);
      nodeMarks.push(
        h(
          'g',
          {
            class: 'kb-chart__node',
            'data-tone': tone || undefined,
            'data-status': tone ? node.status : undefined,
          },
          tooltip(
            `${label}${tone ? ` (${env.statusLabel(node.status)})` : ''}${node.meta && tone ? ` · ${str(node.meta)}` : ''}`
          ),
          h('rect', { class: 'kb-chart__node-box', x, y, width: nodeW, height: nodeH, rx: 6 }),
          h('rect', { class: 'kb-chart__node-bar', x, y, width: 4, height: nodeH, rx: 2 }),
          h(
            'text',
            {
              class: 'kb-chart__node-label',
              x: x + 14,
              y: sub ? y + nodeH / 2 - 8 : y + nodeH / 2,
              'dominant-baseline': 'middle',
            },
            fitText(label, nodeW - 22, FONT)
          ),
          sub
            ? h(
                'text',
                {
                  class: tone ? 'kb-chart__node-status' : 'kb-chart__node-meta',
                  x: x + 14,
                  y: y + nodeH / 2 + 10,
                  'dominant-baseline': 'middle',
                },
                fitText(sub, nodeW - 22, TICK_FONT)
              )
            : null
        )
      );
    }
  }

  const summary = env.t(KB_CHART_MESSAGE_KEYS.summaryFlow, {
    nodes: byId.size,
    stages: layers.length,
    edges: validEdges.length,
  });
  const title = titleOf(p);
  const hasStage = stageIds.length > 0;
  const headers = [
    env.t(KB_CHART_MESSAGE_KEYS.tableStep),
    ...(hasStage ? [env.t(KB_CHART_MESSAGE_KEYS.tableStage)] : []),
    env.t(KB_CHART_MESSAGE_KEYS.tableStatus),
    env.t(KB_CHART_MESSAGE_KEYS.tableNext),
  ];
  const tableRows = layers.flat().map((id) => {
    const node = byId.get(id);
    const next = validEdges
      .filter((edge) => edge.from === id)
      .map(
        (edge) =>
          `${str(byId.get(edge.to).label) || edge.to}${edge.label ? ` (${str(edge.label)})` : ''}`
      )
      .join(', ');
    return [
      str(node.label) || id,
      ...(hasStage ? [stageLabel.get(node.stage) || str(node.stage)] : []),
      statusToneOf(node.status) ? env.statusLabel(node.status) : str(node.meta) || '—',
      next || '—',
    ];
  });
  return chartFigure('flow', p, env, {
    summary,
    svg: svgRoot(
      W,
      H,
      ariaLabel(env, title, summary),
      'kb-chart__svg--diagram',
      heads.length ? h('g', { class: 'kb-chart__stages', 'aria-hidden': 'true' }, heads) : null,
      h('g', { class: 'kb-chart__edges' }, edgeNodes),
      h('g', { class: 'kb-chart__marks' }, nodeMarks),
      edgeLabels.length
        ? h('g', { class: 'kb-chart__labels', 'aria-hidden': 'true' }, edgeLabels)
        : null
    ),
    table: dataTable(title, headers, tableRows),
  });
}
