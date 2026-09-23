/*
 * Kyberion UI — chart layout: scales, ticks, stacking, DAG layering and
 * sequence ordering (pure, exported for tests).
 *
 * Part of the renderer-independent chart layout re-exported by `charts.js`
 * (see its header for the vnode / color / accessibility contract).
 */
import { KB_VIZ_SEQUENTIAL_STEPS, isNum, isRecord, str } from './charts-core.js';

// ---------------------------------------------------------------------------
// Scales, ticks, stacking (exported for tests)
// ---------------------------------------------------------------------------

/** A "nice" step (1, 2, 2.5, 5 × 10^n) splitting `span` into about `count` parts. */
export function niceStep(span, count = 5, integer = false) {
  if (!isNum(span) || span <= 0) return 1;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  // Integer data (day numbers, counts) never gets 2.5-steps or fractions.
  const quarter = !(integer && magnitude < 10);
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : quarter && norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return integer ? Math.max(1, step * magnitude) : step * magnitude;
}

/**
 * Nice axis ticks covering [min, max]; the first / last tick are the domain.
 * A zero-width domain is widened to include 0 (or to [0, 1] at zero).
 */
export function niceTicks(min, max, count = 5, integer = false) {
  let lo = isNum(min) ? min : 0;
  let hi = isNum(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  const step = niceStep(hi - lo, count, integer);
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let index = 0; index <= 1000; index += 1) {
    const value = Number((start + index * step).toPrecision(12));
    if (value > end + step / 2) break;
    ticks.push(value);
  }
  return ticks;
}

/** Linear map from `domain` to `range`; a zero-width domain maps to the range midpoint. */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value) => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0));
}

/**
 * Stack `values[series][category]`: positives grow up from 0, negatives down,
 * each in series order. Returns `[series][category] = [start, end]` (null for
 * a missing value).
 */
export function stackSeries(values) {
  const categories = Math.max(0, ...values.map((row) => row.length));
  const out = values.map(() => []);
  for (let c = 0; c < categories; c += 1) {
    let up = 0;
    let down = 0;
    values.forEach((row, s) => {
      const value = row[c];
      if (!isNum(value)) {
        out[s][c] = null;
      } else if (value >= 0) {
        out[s][c] = [up, up + value];
        up += value;
      } else {
        out[s][c] = [down, down + value];
        down += value;
      }
    });
  }
  return out;
}

/** Sequential step 1..5 for `value` within [min, max]. */
export function sequentialLevel(value, min, max) {
  if (!isNum(value)) return null;
  if (max <= min) return 3;
  const ratio = (value - min) / (max - min);
  return Math.min(KB_VIZ_SEQUENTIAL_STEPS, Math.max(1, Math.floor(ratio * 5) + 1));
}

/** Diverging step 1..5 (3 = neutral midpoint) for `value` around `mid`, scaled by `extent`. */
export function divergingLevel(value, mid, extent) {
  if (!isNum(value)) return null;
  if (!(extent > 0)) return 3;
  const ratio = (value - mid) / extent;
  if (ratio < -0.6) return 1;
  if (ratio < -0.2) return 2;
  if (ratio <= 0.2) return 3;
  if (ratio <= 0.6) return 4;
  return 5;
}

// ---------------------------------------------------------------------------
// DAG layering & sequence ordering (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Layer a (possibly cyclic) graph left-to-right, deterministically.
 *   - When every node names a `stage`, layers are stages: the `stages` order
 *     first, then stages in first-appearance order.
 *   - Otherwise a node's layer is its longest path from a source; edges that
 *     close a cycle (back edges in input-order DFS) are ignored.
 * Within a layer, nodes start in input order and are then ordered by one
 * down-sweep and one up-sweep of the barycenter heuristic (ties keep input
 * order), which reduces edge crossings without any randomness.
 * @returns {{ layers: string[][], layerOf: Map<string, number>, stageIds: string[] }}
 */
export function layerDag(nodes, edges, stages = []) {
  const ids = [];
  const seen = new Set();
  const stageOf = new Map();
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || seen.has(node.id)) continue;
    seen.add(node.id);
    ids.push(node.id);
    if (typeof node.stage === 'string' && node.stage) stageOf.set(node.id, node.stage);
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  const validEdges = edges.filter(
    (edge) => isRecord(edge) && seen.has(edge.from) && seen.has(edge.to) && edge.from !== edge.to
  );
  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  for (const edge of validEdges) {
    preds.get(edge.to).push(edge.from);
    succs.get(edge.from).push(edge.to);
  }

  const layerOf = new Map();
  let stageIds = [];
  if (ids.length > 0 && ids.every((id) => stageOf.has(id))) {
    const declared = stages
      .map((stage) => (typeof stage === 'string' ? stage : isRecord(stage) ? stage.id : null))
      .filter((stage) => typeof stage === 'string' && stage);
    stageIds = [...new Set([...declared, ...ids.map((id) => stageOf.get(id))])];
    const used = new Set(ids.map((id) => stageOf.get(id)));
    stageIds = stageIds.filter((stage) => used.has(stage));
    const stageIndex = new Map(stageIds.map((stage, index) => [stage, index]));
    for (const id of ids) layerOf.set(id, stageIndex.get(stageOf.get(id)));
  } else {
    // Back edges: found by an input-order DFS; ignored for layering.
    const state = new Map();
    const back = new Set();
    const visit = (id) => {
      state.set(id, 1);
      for (const next of succs.get(id)) {
        if (state.get(next) === 1) back.add(`${id}\u0000${next}`);
        else if (!state.has(next)) visit(next);
      }
      state.set(id, 2);
    };
    for (const id of ids) if (!state.has(id)) visit(id);
    const depth = new Map();
    const resolve = (id) => {
      if (depth.has(id)) return depth.get(id);
      depth.set(id, 0);
      let value = 0;
      for (const from of preds.get(id)) {
        if (back.has(`${from}\u0000${id}`)) continue;
        value = Math.max(value, resolve(from) + 1);
      }
      depth.set(id, value);
      return value;
    };
    for (const id of ids) layerOf.set(id, resolve(id));
  }

  const count = ids.length ? Math.max(...ids.map((id) => layerOf.get(id))) + 1 : 0;
  const layers = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layerOf.get(id)].push(id);

  const position = new Map();
  const index = () => layers.forEach((layer) => layer.forEach((id, i) => position.set(id, i)));
  index();
  const sweep = (layer, neighbours) => {
    const keyed = layer.map((id) => {
      const refs = neighbours.get(id).filter((other) => position.has(other));
      const center = refs.length
        ? refs.reduce((sum, other) => sum + position.get(other), 0) / refs.length
        : position.get(id);
      return { id, center };
    });
    keyed.sort((a, b) => a.center - b.center || order.get(a.id) - order.get(b.id));
    return keyed.map((entry) => entry.id);
  };
  for (let l = 1; l < layers.length; l += 1) {
    layers[l] = sweep(layers[l], preds);
    index();
  }
  for (let l = layers.length - 2; l >= 0; l -= 1) {
    layers[l] = sweep(layers[l], succs);
    index();
  }
  return { layers, layerOf, stageIds };
}

function timeKey(value) {
  if (isNum(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && /\d{4}-\d{2}-\d{2}/.test(value)) return parsed;
  }
  return null;
}

/**
 * Resolve lanes and message order for a sequence diagram.
 *   - Lanes: declared participants in order, then any id a message references
 *     that was not declared, in first-appearance order.
 *   - Messages: input order, unless every message has a comparable `at`
 *     (all numbers or all ISO dates), then a stable sort by `at`. Messages
 *     with an empty `from` / `to` are dropped.
 */
export function orderSequence(participants, messages) {
  const lanes = [];
  const laneIndex = new Map();
  const addLane = (id, label) => {
    if (typeof id !== 'string' || !id || laneIndex.has(id)) return;
    laneIndex.set(id, lanes.length);
    lanes.push({ id, label: label || id });
  };
  for (const participant of participants) {
    if (typeof participant === 'string') addLane(participant, participant);
    else if (isRecord(participant)) addLane(participant.id, str(participant.label));
  }
  const rows = messages.filter(
    (message) =>
      isRecord(message) &&
      typeof message.from === 'string' &&
      message.from &&
      typeof message.to === 'string' &&
      message.to
  );
  for (const message of rows) {
    addLane(message.from, message.from);
    addLane(message.to, message.to);
  }
  const keys = rows.map((message) => timeKey(message.at));
  let ordered = rows.map((message, index) => ({ message, index }));
  if (rows.length > 1 && keys.every((key) => key !== null)) {
    ordered = ordered
      .map((entry) => ({ ...entry, key: keys[entry.index] }))
      .sort((a, b) => a.key - b.key || a.index - b.index);
  }
  return { lanes, laneIndex, messages: ordered.map((entry) => entry.message) };
}
