/**
 * Canonical structured-section model — the single normalization point shared
 * by every media renderer (pptx runtime, docx report builder, pdf report
 * builder, xlsx tracker builder).
 *
 * Each section field maps to a typed model; raw brief input may come in
 * several equivalent shapes (flat arrays, nested objects, singular `table`
 * vs plural `tables`, `label`/`title`/`name` aliases). The normalizers here
 * accept them all and emit one canonical shape so format-specific renderers
 * never re-implement the same guards.
 *
 * When adding a new field: add the normalizer here, add the key to
 * STRUCTURED_FIELD_KEYS, add the model to StructuredSectionModel, and let
 * each renderer read it — the propagate & presence-check plumbing then works
 * unchanged.
 */

export interface StructuredTable {
  columns: string[];
  rows: string[][];
  colWidths?: number[];
  title?: string;
}

export interface StructuredMetric {
  value: string;
  label: string;
}

export interface StructuredStep {
  title: string;
  description: string;
}

export interface StructuredColumn {
  title: string;
  items: string[];
}

export interface StructuredQuote {
  text: string;
  attribution: string;
}

export interface StructuredImage {
  path: string;
  caption: string;
  width?: number;
  height?: number;
  align?: 'left' | 'center' | 'right';
  cols?: number;
  rows?: number;
}

export interface StructuredChecklistItem {
  text: string;
  done: boolean;
}

export interface StructuredWbsEntry {
  level: number;
  label: string;
}

export interface StructuredTimelineEntry {
  label: string;
  start: string;
  end: string;
  owner: string;
}

export interface StructuredMatrix {
  xAxis: string;
  yAxis: string;
  quadrants: Array<{ title: string; items: string[] }>;
}

export interface StructuredProcessStep {
  label: string;
  description: string;
}

export interface StructuredOrgMember {
  name: string;
  role: string;
  level: number;
  index: number;
  parent: number;
}

export interface StructuredPyramidLayer {
  label: string;
  description: string;
}

export interface StructuredFlowLane {
  lane: string;
  steps: StructuredProcessStep[];
}

export interface StructuredRoadmapPeriod {
  period: string;
  title: string;
  items: string[];
}

export interface StructuredKpiEntry {
  metric: string;
  value: string;
  target: string;
  delta: string;
  trend: string;
}

/** Canonical model — a renderer reads `.model.<field>` once. */
export interface StructuredSectionModel {
  table: StructuredTable | null;
  tables: StructuredTable[];
  metrics: StructuredMetric[];
  steps: StructuredStep[];
  columns: StructuredColumn[];
  checklist: StructuredChecklistItem[];
  quote: StructuredQuote | null;
  image: StructuredImage | null;
  cta: string;
  divider: boolean;
  wbs: StructuredWbsEntry[];
  timeline: StructuredTimelineEntry[];
  matrix: StructuredMatrix | null;
  process: StructuredProcessStep[];
  org: StructuredOrgMember[];
  pyramid: StructuredPyramidLayer[];
  flow: StructuredFlowLane[];
  roadmap: StructuredRoadmapPeriod[];
  kpiTable: StructuredKpiEntry[];
}

/** Field names that trigger structured-content handling on a section. */
export const STRUCTURED_FIELD_KEYS = [
  'table',
  'tables',
  'metrics',
  'steps',
  'columns',
  'checklist',
  'quote',
  'image',
  'cta',
  'divider',
  'wbs',
  'timeline',
  'matrix',
  'process',
  'org',
  'pyramid',
  'flow',
  'roadmap',
  'kpi_table',
  'kpiTable',
] as const;

const hasStructured = (section: any): boolean =>
  section != null &&
  typeof section === 'object' &&
  STRUCTURED_FIELD_KEYS.some((key) => {
    const v = (section as any)[key];
    if (key === 'divider') return v === true;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim() !== '';
    if (isObj(v)) return Object.keys(v).length > 0;
    return false;
  });

export { hasStructured };

// ─── Normalizers ────────────────────────────────────────────────────────────

const str = (v: any): string => String(v ?? '').trim();
const isObj = (v: any): v is Record<string, any> => Boolean(v) && typeof v === 'object';

function normalizeTable(raw: any): StructuredTable | null {
  const toRow = (row: any, cols: string[]): string[] =>
    Array.isArray(row)
      ? row.map((cell: any) => str(cell))
      : isObj(row)
        ? cols.length > 0
          ? cols.map((c) => str(row[c]))
          : Object.values(row).map((cell: any) => str(cell))
        : [str(row)];
  // bare rows[][] form
  if (Array.isArray(raw) && raw.length > 0 && raw.every((r) => Array.isArray(r) || isObj(r))) {
    return { columns: [], rows: raw.map((r) => toRow(r, [])) };
  }
  if (isObj(raw) && Array.isArray(raw.rows) && raw.rows.length > 0) {
    const columns = Array.isArray(raw.columns) ? raw.columns.map(str) : [];
    return {
      columns,
      rows: raw.rows.map((r: any) => toRow(r, columns)),
      colWidths: Array.isArray(raw.colWidths) ? raw.colWidths.map(Number) : undefined,
      title: str(raw.title) || undefined,
    };
  }
  return null;
}

function normalizeMetrics(raw: any): StructuredMetric[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) => {
      if (typeof entry === 'string') {
        const parts = entry.trim().split(/\s+/);
        return parts.length > 1
          ? { value: parts[0], label: parts.slice(1).join(' ') }
          : { value: entry.trim(), label: '' };
      }
      return { value: str(entry?.value), label: str(entry?.label ?? entry?.name) };
    })
    .filter((e) => e.value || e.label);
}

function normalizeSteps(raw: any): StructuredStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      typeof entry === 'string'
        ? { title: entry.trim(), description: '' }
        : isObj(entry)
          ? {
              title: str(entry.title ?? entry.label ?? entry.name),
              description: str(entry.description ?? entry.detail),
            }
          : null
    )
    .filter((e): e is StructuredStep => Boolean(e?.title || e?.description));
}

function normalizeColumns(raw: any): StructuredColumn[] {
  const toColumn = (entry: any): StructuredColumn | null =>
    isObj(entry)
      ? {
          title: str(entry.title ?? entry.label ?? entry.name),
          items: Array.isArray(entry.items)
            ? entry.items.map(str)
            : Array.isArray(entry.body)
              ? entry.body.map(str)
              : [],
        }
      : null;
  if (Array.isArray(raw)) {
    return raw
      .map(toColumn)
      .filter((c): c is StructuredColumn => Boolean(c && (c.title || c.items.length > 0)));
  }
  // Named-column form: {left|center|right: {title, items}}
  if (isObj(raw)) {
    return ['left', 'right', 'center']
      .map((key) => toColumn(raw[key]))
      .filter((c): c is StructuredColumn => Boolean(c && (c.title || c.items.length > 0)));
  }
  return [];
}

function normalizeChecklist(raw: any): StructuredChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      typeof entry === 'string'
        ? { text: entry.trim(), done: false }
        : isObj(entry)
          ? {
              text: str(entry.item ?? entry.text ?? entry.label ?? entry.name),
              done: Boolean(entry.done ?? entry.checked ?? entry.completed),
            }
          : null
    )
    .filter((e): e is StructuredChecklistItem => Boolean(e?.text));
}

function normalizeQuote(raw: any): StructuredQuote | null {
  if (typeof raw === 'string' && raw.trim()) return { text: raw.trim(), attribution: '' };
  if (!isObj(raw)) return null;
  const text = str(raw.text ?? raw.quote ?? raw.body);
  if (!text) return null;
  return { text, attribution: str(raw.attribution ?? raw.source ?? raw.author) };
}

function normalizeImage(raw: any): StructuredImage | null {
  if (typeof raw === 'string' && raw.trim()) return { path: raw.trim(), caption: '' };
  if (!isObj(raw)) return null;
  const path = str(raw.path ?? raw.src);
  if (!path) return null;
  return {
    path,
    caption: str(raw.caption ?? raw.alt),
    width: raw.width !== undefined ? Number(raw.width) : undefined,
    height: raw.height !== undefined ? Number(raw.height) : undefined,
    align: raw.align === 'left' || raw.align === 'right' ? raw.align : 'center',
    cols: raw.cols !== undefined ? Number(raw.cols) : undefined,
    rows: raw.rows !== undefined ? Number(raw.rows) : undefined,
  };
}

function normalizeWbs(raw: any): StructuredWbsEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StructuredWbsEntry[] = [];
  const walk = (entry: any, level: number, prefix: string) => {
    if (typeof entry === 'string') {
      out.push({ level, label: prefix ? `${prefix} ${entry}` : entry });
      return;
    }
    if (!isObj(entry)) return;
    const id = str(entry.id ?? entry.no);
    const name = str(entry.name ?? entry.title ?? entry.label);
    if (name) out.push({ level, label: id ? `${id} ${name}` : name });
    const kids = Array.isArray(entry.items)
      ? entry.items
      : Array.isArray(entry.children)
        ? entry.children
        : [];
    kids.forEach((kid: any, i: number) =>
      walk(kid, level + 1, id && !str(kid?.id).trim() ? `${id}.${i + 1}` : '')
    );
  };
  raw.forEach((entry: any) => {
    if (isObj(entry) && 'level' in entry) {
      out.push({
        level: Math.max(0, Math.floor(Number(entry.level) || 1)),
        label: str(entry.name ?? entry.title ?? entry.label),
      });
    } else {
      walk(entry, 1, '');
    }
  });
  return out.filter((e) => e.label);
}

function normalizeTimeline(raw: any): StructuredTimelineEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      isObj(entry)
        ? {
            label: str(entry.label ?? entry.phase ?? entry.name ?? entry.title),
            start: str(entry.start ?? entry.date ?? entry.from),
            end: str(entry.end ?? entry.to),
            owner: str(entry.owner ?? entry.assignee),
          }
        : null
    )
    .filter((e): e is StructuredTimelineEntry => Boolean(e?.label || e?.start || e?.end));
}

function normalizeMatrix(raw: any): StructuredMatrix | null {
  if (!isObj(raw) || !Array.isArray(raw.quadrants)) return null;
  const quadrants = raw.quadrants.slice(0, 4).map((q: any) => ({
    title: str(q?.title ?? q?.label ?? q?.name),
    items: (Array.isArray(q?.items) ? q.items : []).map(str),
  }));
  if (quadrants.length === 0) return null;
  return {
    xAxis: str(raw.x_axis ?? raw.xAxis),
    yAxis: str(raw.y_axis ?? raw.yAxis),
    quadrants,
  };
}

function normalizeProcess(raw: any): StructuredProcessStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      typeof entry === 'string'
        ? { label: entry.trim(), description: '' }
        : isObj(entry)
          ? {
              label: str(entry.label ?? entry.name ?? entry.title),
              description: str(entry.description ?? entry.detail),
            }
          : null
    )
    .filter((e): e is StructuredProcessStep => Boolean(e?.label));
}

function normalizeOrg(raw: any): StructuredOrgMember[] {
  if (!Array.isArray(raw)) return [];
  const out: StructuredOrgMember[] = [];
  const walk = (entry: any, level: number, parent: number) => {
    if (!isObj(entry)) return;
    const name = str(entry.name ?? entry.title);
    const role = str(entry.role ?? entry.title_role);
    if (!name) return;
    const index = out.length;
    out.push({ name, role, level, index, parent });
    const kids = Array.isArray(entry.reports)
      ? entry.reports
      : Array.isArray(entry.children)
        ? entry.children
        : [];
    kids.forEach((kid: any) => walk(kid, level + 1, index));
  };
  raw.forEach((entry: any) => {
    if (isObj(entry) && 'level' in entry && !entry.reports && !entry.children) {
      const index = out.length;
      out.push({
        name: str(entry.name),
        role: str(entry.role),
        level: Math.max(1, Math.floor(Number(entry.level) || 1)),
        index,
        parent: -1,
      });
    } else {
      walk(entry, 1, -1);
    }
  });
  return out.filter((e) => e.name);
}

function normalizePyramid(raw: any): StructuredPyramidLayer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      typeof entry === 'string'
        ? { label: entry.trim(), description: '' }
        : isObj(entry)
          ? {
              label: str(entry.label ?? entry.name ?? entry.title),
              description: str(entry.description),
            }
          : null
    )
    .filter((e): e is StructuredPyramidLayer => Boolean(e?.label))
    .slice(0, 6);
}

function normalizeFlow(raw: any): StructuredFlowLane[] {
  if (!Array.isArray(raw)) return [];
  const lanes: StructuredFlowLane[] = [];
  const push = (lane: string, label: string, description = '') => {
    if (!label) return;
    let laneObj = lanes.find((l) => l.lane === lane);
    if (!laneObj) {
      laneObj = { lane, steps: [] };
      lanes.push(laneObj);
    }
    laneObj.steps.push({ label, description });
  };
  raw.forEach((entry: any) => {
    if (!isObj(entry)) return;
    if (entry.lane !== undefined && (Array.isArray(entry.steps) || Array.isArray(entry.items))) {
      const lane = str(entry.lane);
      (entry.steps ?? entry.items ?? []).forEach((s: any) =>
        typeof s === 'string'
          ? push(lane, s.trim())
          : isObj(s)
            ? push(lane, str(s.label ?? s.name ?? s.title), str(s.description ?? s.detail))
            : null
      );
      return;
    }
    push(
      str(entry.lane ?? entry.group ?? entry.lane_name),
      str(entry.label ?? entry.name ?? entry.title),
      str(entry.description ?? entry.detail)
    );
  });
  return lanes.filter((l) => l.steps.length > 0);
}

function normalizeRoadmap(raw: any): StructuredRoadmapPeriod[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      isObj(entry)
        ? {
            period: str(entry.period ?? entry.quarter ?? entry.phase),
            title: str(entry.title ?? entry.label ?? entry.name),
            items: (Array.isArray(entry.items) ? entry.items : []).map(str),
          }
        : null
    )
    .filter((e): e is StructuredRoadmapPeriod => Boolean(e?.period || e?.title))
    .slice(0, 6);
}

function normalizeKpiTable(raw: any): StructuredKpiEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: any) =>
      isObj(entry)
        ? {
            metric: str(entry.metric ?? entry.label ?? entry.name),
            value: str(entry.value),
            target: str(entry.target),
            delta: str(entry.delta ?? entry.change),
            trend: str(entry.trend ?? entry.direction),
          }
        : null
    )
    .filter((e): e is StructuredKpiEntry => Boolean(e?.metric || e?.value));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Normalize one section object into the canonical structured model.
 * Renderers consume `model.*` — they never touch the raw brief shape.
 */
export function normalizeStructuredSection(section: any): StructuredSectionModel {
  const rawTables = Array.isArray(section?.tables) ? section.tables : [];
  const table = rawTables.includes(section?.table) ? null : normalizeTable(section?.table);
  const tables = rawTables.map(normalizeTable).filter(Boolean) as StructuredTable[];
  return {
    table,
    tables,
    metrics: normalizeMetrics(section?.metrics),
    steps: normalizeSteps(section?.steps),
    columns: normalizeColumns(section?.columns),
    checklist: normalizeChecklist(section?.checklist),
    quote: normalizeQuote(section?.quote),
    image: normalizeImage(section?.image),
    cta:
      typeof section?.cta === 'string'
        ? section.cta.trim()
        : isObj(section?.cta)
          ? str(section.cta.text ?? section.cta.label)
          : section?.cta === true
            ? ''
            : '',
    divider: section?.divider === true,
    wbs: normalizeWbs(section?.wbs),
    timeline: normalizeTimeline(section?.timeline),
    matrix: normalizeMatrix(section?.matrix),
    process: normalizeProcess(section?.process),
    org: normalizeOrg(section?.org),
    pyramid: normalizePyramid(section?.pyramid),
    flow: normalizeFlow(section?.flow),
    roadmap: normalizeRoadmap(section?.roadmap),
    kpiTable: normalizeKpiTable(section?.kpi_table ?? section?.kpiTable),
  };
}

/** Pick just the structured fields off a section — for propagation passes. */
export function pickStructuredSectionFields(section: any): Partial<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const key of STRUCTURED_FIELD_KEYS) {
    const v = (section as any)?.[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
