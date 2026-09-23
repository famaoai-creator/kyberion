/**
 * UI-07 — chronos `display:*` / `kb-*` A2UI types → `kyberion-base` (`ui:*`).
 *
 * Chronos historically rendered its own A2UI vocabulary (`display:*`, `kb-*`)
 * with a private React + Tailwind library. The shared `@agent/shared-ui`
 * renderer now owns the look (`.kb-*` classes from `kyberion-ui.css`), so this
 * module rewrites every chronos component into an equivalent `ui:*` subtree
 * before rendering. The `display:*` / `kb-*` wire types stay valid (plan §3:
 * kept for compatibility); only their rendering moved.
 *
 * Pure functions (no JSX): `expandChronosComponents` takes the A2UI component list
 * and returns a new list the shared `A2UIRenderer` can draw directly. Types it
 * does not rewrite pass through unchanged — catalog types render as usual,
 * the few interactive chronos-only types (`kb-artifact-tile`,
 * `kb-intervention-panel`) plus `chronos:code` go to the renderer's
 * `fallback` registry, and anything else degrades to the renderer's
 * unknown-type handling.
 */

import { isKbStatus } from '@agent/shared-ui';

export interface ChronosA2UIComponent {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: readonly string[];
}

/**
 * Localize one prop string: `key` (an explicit `*Key` prop) wins, else a
 * known English default is looked up in the chronos vocabulary, else the text
 * is shown as-is (it is caller data, already localized by the producer).
 */
export type ChronosA2UITranslate = (key: string | undefined, text: string) => string;

/** Chronos-only local type for `display:code` / `display:log` (mono pre block). */
export const CHRONOS_CODE_TYPE = 'chronos:code';
export const KB_ARTIFACT_TILE_TYPE = 'kb-artifact-tile';
export const KB_INTERVENTION_PANEL_TYPE = 'kb-intervention-panel';

/** English defaults emitted by chronos producers → chronos vocabulary key. */
export const A2UI_FALLBACK_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Intent: 'chronos_a2ui_intent',
  Plan: 'chronos_a2ui_plan',
  State: 'chronos_a2ui_state',
  Result: 'chronos_a2ui_result',
  Status: 'chronos_a2ui_status',
  Progress: 'chronos_a2ui_progress',
  Preview: 'chronos_a2ui_preview',
  'file missing': 'chronos_a2ui_file_missing',
  'Intervention Required': 'chronos_a2ui_intervention_required',
  'Pipeline Execution': 'chronos_a2ui_pipeline_execution',
  'Execution Output': 'chronos_a2ui_execution_output',
  Readiness: 'chronos_a2ui_readiness',
  Schedule: 'chronos_a2ui_schedule',
  'Operator Snapshot': 'chronos_a2ui_operator_snapshot',
  'Chronos Dashboard': 'chronos_a2ui_dashboard',
  'Active Missions': 'chronos_a2ui_active_missions',
  'Mission Control': 'chronos_a2ui_mission_control',
  'Visible Missions': 'chronos_a2ui_visible_missions',
  'Mission Registry View': 'chronos_a2ui_mission_registry',
  'Agent Catalog': 'chronos_a2ui_agent_catalog',
  'Available Agents': 'chronos_a2ui_available_agents',
  'Vital Check': 'chronos_a2ui_vital_check',
  'System Vital Signs': 'chronos_a2ui_system_vital_signs',
  'Runtime Diagnostics': 'chronos_a2ui_runtime_diagnostics',
  'Recent Events': 'chronos_a2ui_recent_events',
  Governance: 'chronos_a2ui_governance',
  'Build & Test': 'chronos_a2ui_build_test',
  missions: 'chronos_a2ui_missions',
  runtime: 'chronos_a2ui_runtime',
  runtimes: 'chronos_a2ui_runtimes',
  outbox: 'chronos_a2ui_outbox',
  exit: 'chronos_a2ui_exit_code',
  Tier: 'chronos_a2ui_tier',
  Type: 'chronos_a2ui_type',
  Next: 'chronos_a2ui_next',
  Provider: 'chronos_a2ui_provider',
  Model: 'chronos_a2ui_model',
  Capabilities: 'chronos_a2ui_capabilities',
  Checkpoints: 'chronos_a2ui_checkpoints',
  'Next Tasks': 'chronos_a2ui_next_tasks',
});

/** Identity translation (tests, and callers without a locale). */
export const identityTranslate: ChronosA2UITranslate = (_key, text) => text;

// ---------------------------------------------------------------------------
// Prop hygiene
// ---------------------------------------------------------------------------

const MAX_NESTING = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strip script tags / inline handlers from string props (kept from the
 * pre-UI-07 library). React escapes text anyway; this keeps hostile markup out
 * of props that reach `onAction` payloads.
 */
export function sanitizeProps(props: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  if (depth > MAX_NESTING) return clean;
  for (const [key, value] of Object.entries(props)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = sanitizeValue(value, depth + 1);
  }
  return clean;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+\s*=/gi, 'data-blocked=');
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (isRecord(value)) return sanitizeProps(value, depth);
  return value;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function cellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry;
  return out as T;
}

// ---------------------------------------------------------------------------
// Status vocabulary: chronos wire values → canonical `KbStatus`
// ---------------------------------------------------------------------------

/** Chronos-specific status words that have a canonical equivalent. */
const STATUS_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ok: 'ready',
  healthy: 'ready',
  success: 'done',
  succeeded: 'done',
  warning: 'degraded',
  warn: 'degraded',
  attention: 'degraded',
  critical: 'error',
  danger: 'error',
  idle: 'ready',
  queued: 'pending',
  waiting: 'pending',
  in_progress: 'active',
  inprogress: 'active',
  online: 'connected',
});

/** Map a chronos status word to a canonical status, or `undefined` when there is none. */
export function toCanonicalStatus(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (isKbStatus(key)) return key;
  return Object.prototype.hasOwnProperty.call(STATUS_ALIASES, key)
    ? STATUS_ALIASES[key]
    : undefined;
}

const BADGE_TONES: ReadonlySet<string> = new Set([
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
]);

function badgeTone(value: unknown): string {
  return typeof value === 'string' && BADGE_TONES.has(value) ? value : 'neutral';
}

const ALERT_TONES: Readonly<Record<string, string>> = Object.freeze({
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
  danger: 'danger',
});

const PRIORITY_TONES: Readonly<Record<string, string>> = Object.freeze({
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
});

const STEP_STATUSES: Readonly<Record<string, string>> = Object.freeze({
  done: 'done',
  active: 'active',
  pending: 'pending',
});

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

interface ExpandContext {
  tx: ChronosA2UITranslate;
  out: ChronosA2UIComponent[];
  used: Set<string>;
  depth: number;
}

function freshId(ctx: ExpandContext, base: string): string {
  let id = base;
  let n = 1;
  while (ctx.used.has(id)) id = `${base}~${n++}`;
  ctx.used.add(id);
  return id;
}

function push(
  ctx: ExpandContext,
  id: string,
  type: string,
  props: Record<string, unknown>,
  children?: string[]
): string {
  ctx.out.push(
    children && children.length
      ? { id, type, props: compact(props), children }
      : { id, type, props: compact(props) }
  );
  return id;
}

/** Translate `props[field]` with `props[field + 'Key']`. */
function tr(ctx: ExpandContext, props: Record<string, unknown>, field: string): string | undefined {
  const value = text(props[field]);
  if (value === undefined) return undefined;
  const key = text(props[`${field}Key`]);
  return ctx.tx(key, value);
}

/** Leaf block with an optional small title: `ui:stack` [caption, block]. */
function titled(
  ctx: ExpandContext,
  id: string,
  title: string | undefined,
  build: (childId: string) => string,
  extraChildren: string[] = []
): string {
  if (!title && extraChildren.length === 0) return build(id);
  const titleId = title
    ? push(ctx, freshId(ctx, `${id}/title`), 'ui:text', { text: title, variant: 'caption' })
    : undefined;
  const bodyId = build(freshId(ctx, `${id}/body`));
  return push(ctx, id, 'ui:stack', { gap: 'sm' }, [
    ...(titleId ? [titleId] : []),
    bodyId,
    ...extraChildren,
  ]);
}

/** Nested `{type, props}` items (display:section / display:grid / kb-layout-grid). */
function expandNested(ctx: ExpandContext, parentId: string, items: unknown): string[] {
  if (ctx.depth >= MAX_NESTING) return [];
  const ids: string[] = [];
  records(items).forEach((item, index) => {
    const type = text(item.type);
    if (!type) return;
    const id = freshId(ctx, `${parentId}/${index}`);
    ctx.depth += 1;
    expandOne(
      ctx,
      {
        id,
        type,
        props: isRecord(item.props) ? item.props : {},
      },
      []
    );
    ctx.depth -= 1;
    ids.push(id);
  });
  return ids;
}

function metricProps(ctx: ExpandContext, m: Record<string, unknown>): Record<string, unknown> {
  const trend = m.trend === 'up' || m.trend === 'down' || m.trend === 'flat' ? m.trend : undefined;
  const value = typeof m.value === 'number' || typeof m.value === 'string' ? m.value : '';
  return {
    label: tr(ctx, m, 'label') ?? '',
    value,
    unit: text(m.unit),
    trend,
    description: tr(ctx, m, 'description'),
  };
}

function chartData(value: unknown): Array<{ label: string; value: number | null }> {
  return records(value).map((d) => ({ label: text(d.label) ?? '', value: num(d.value) }));
}

/**
 * Expand one component. `children` are the component's own A2UI child ids;
 * they are appended to the expanded root (container types) so id-based trees
 * keep working.
 */
function expandOne(ctx: ExpandContext, component: ChronosA2UIComponent, children: string[]): void {
  const { id, type } = component;
  const p = sanitizeProps(isRecord(component.props) ? component.props : {});
  ctx.used.add(id);

  switch (type) {
    case 'display:hero': {
      const status = text(p.status);
      const canonical = toCanonicalStatus(status);
      const heroId = freshId(ctx, `${id}/hero`);
      push(ctx, heroId, 'ui:next-action', {
        eyebrow: tr(ctx, p, 'eyebrow'),
        title: tr(ctx, p, 'title') ?? '',
        reason: tr(ctx, p, 'description'),
        state: 'ready',
      });
      if (!status && children.length === 0) {
        // Keep the original id on the rendered root.
        ctx.out[ctx.out.length - 1] = { ...ctx.out[ctx.out.length - 1], id };
        return;
      }
      const statusId = status
        ? canonical
          ? push(ctx, freshId(ctx, `${id}/status`), 'ui:status-pill', { status: canonical })
          : push(ctx, freshId(ctx, `${id}/status`), 'ui:badge', {
              label: tr(ctx, p, 'status') ?? status,
              tone: 'neutral',
            })
        : undefined;
      push(ctx, id, 'ui:stack', { gap: 'sm' }, [
        heroId,
        ...(statusId ? [statusId] : []),
        ...children,
      ]);
      return;
    }

    case 'display:badges':
      titled(
        ctx,
        id,
        tr(ctx, p, 'title'),
        (bodyId) =>
          push(
            ctx,
            bodyId,
            'ui:stack',
            { gap: 'xs', direction: 'horizontal', wrap: true },
            records(p.items).map((item, index) =>
              push(ctx, freshId(ctx, `${bodyId}/${index}`), 'ui:badge', {
                label: tr(ctx, item, 'label') ?? '',
                tone: badgeTone(item.tone),
              })
            )
          ),
        children
      );
      return;

    case 'display:section':
    case 'display:card': {
      const nested = type === 'display:section' ? expandNested(ctx, id, p.items) : [];
      const footer = type === 'display:card' ? tr(ctx, p, 'footer') : undefined;
      const footerId = footer
        ? push(ctx, freshId(ctx, `${id}/footer`), 'ui:text', { text: footer, variant: 'caption' })
        : undefined;
      push(
        ctx,
        id,
        'ui:section',
        { title: tr(ctx, p, 'title'), description: tr(ctx, p, 'description') },
        [...nested, ...(footerId ? [footerId] : []), ...children]
      );
      return;
    }

    case 'display:grid':
    case 'kb-layout-grid': {
      const cols = num(type === 'display:grid' ? p.cols : p.columns);
      const columns = cols && cols >= 1 ? Math.min(6, Math.round(cols)) : 2;
      push(ctx, id, 'ui:grid', { columns, gap: 'md' }, [
        ...expandNested(ctx, id, p.children),
        ...children,
      ]);
      return;
    }

    case 'display:gauge': {
      const value = num(p.value);
      push(ctx, id, 'ui:meter', {
        label: tr(ctx, p, 'label'),
        value: value === null ? null : Math.min(100, Math.max(0, value)),
        max: 100,
        unit: text(p.unit),
        // Higher is healthier (pre-UI-07 semantics: >=80 ok, >=50 warning).
        thresholds: [
          { value: 0, tone: 'danger' },
          { value: 50, tone: 'warning' },
          { value: 80, tone: 'success' },
        ],
      });
      return;
    }

    case 'display:log':
      titled(
        ctx,
        id,
        tr(ctx, p, 'title'),
        (bodyId) =>
          push(ctx, bodyId, CHRONOS_CODE_TYPE, {
            code: (Array.isArray(p.lines) ? p.lines : [])
              .map((line) => (typeof line === 'string' ? line : String(cellValue(line) ?? '')))
              .join('\n'),
            variant: 'log',
          }),
        children
      );
      return;

    case 'display:code':
      titled(
        ctx,
        id,
        tr(ctx, p, 'title'),
        (bodyId) =>
          push(ctx, bodyId, CHRONOS_CODE_TYPE, {
            code: typeof p.code === 'string' ? p.code : String(cellValue(p.code) ?? ''),
            language: text(p.language),
            variant: 'code',
          }),
        children
      );
      return;

    case 'display:table': {
      const headers = Array.isArray(p.headers) ? p.headers : [];
      const headerKeys = Array.isArray(p.headerKeys) ? p.headerKeys : [];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const width = Math.max(
        headers.length,
        ...rows.map((row) =>
          Array.isArray(row) ? row.length : isRecord(row) ? Object.keys(row).length : 0
        )
      );
      let statusTaken = false;
      const columns = Array.from({ length: width }, (_, index) => {
        const raw = text(headers[index]) ?? '';
        // A column headed "Status" gets the `status` key so canonical values
        // render as status pills (shared `ui:table` convention).
        const isStatus = !statusTaken && /^status$/i.test(raw.trim());
        if (isStatus) statusTaken = true;
        return {
          key: isStatus ? 'status' : `c${index}`,
          label: raw ? ctx.tx(text(headerKeys[index]), raw) : '',
        };
      });
      const tableRows = rows.map((row) => {
        const cells = Array.isArray(row) ? row : isRecord(row) ? Object.values(row) : [row];
        const record: Record<string, string | number | boolean | null> = {};
        columns.forEach((column, index) => {
          const value = cellValue(cells[index]);
          record[column.key] =
            column.key === 'status' && typeof value === 'string'
              ? (toCanonicalStatus(value) ?? value)
              : value;
        });
        return record;
      });
      push(
        ctx,
        id,
        'ui:table',
        { caption: tr(ctx, p, 'title'), columns, rows: tableRows },
        children
      );
      return;
    }

    case 'display:status': {
      const status = text(p.status) ?? 'pending';
      const canonical = toCanonicalStatus(status);
      const detail = tr(ctx, p, 'detail');
      push(ctx, id, 'ui:list', {
        variant: 'plain',
        items: [
          compact({
            title: tr(ctx, p, 'label') ?? '',
            meta: canonical ? detail : [detail, status].filter(Boolean).join(' · ') || undefined,
            status: canonical,
          }),
        ],
      });
      return;
    }

    case 'display:kv':
      titled(
        ctx,
        id,
        tr(ctx, p, 'title'),
        (bodyId) =>
          push(ctx, bodyId, 'ui:kv', {
            items: records(p.entries).map((entry) => ({
              label: ctx.tx(text(entry.keyKey), text(entry.key) ?? ''),
              value: (() => {
                const value = cellValue(entry.value);
                return value === null ? '' : value;
              })(),
              mono: true,
            })),
          }),
        children
      );
      return;

    case 'display:metric':
      push(ctx, id, 'ui:metric', metricProps(ctx, p));
      return;

    case 'display:metrics-row': {
      const metrics = records(p.metrics);
      push(ctx, id, 'ui:grid', { columns: Math.max(1, Math.min(metrics.length, 4)), gap: 'md' }, [
        ...metrics.map((metric, index) =>
          push(ctx, freshId(ctx, `${id}/${index}`), 'ui:metric', metricProps(ctx, metric))
        ),
        ...children,
      ]);
      return;
    }

    case 'display:timeline':
      titled(
        ctx,
        id,
        tr(ctx, p, 'title'),
        (bodyId) =>
          push(ctx, bodyId, 'ui:list', {
            variant: 'timeline',
            items: records(p.events).map((event) =>
              compact({
                title: tr(ctx, event, 'label') ?? '',
                meta:
                  [text(event.time), tr(ctx, event, 'detail')].filter(Boolean).join(' · ') ||
                  undefined,
                status: toCanonicalStatus(event.status),
              })
            ),
          }),
        children
      );
      return;

    case 'display:list':
      titled(
        ctx,
        id,
        tr(ctx, p, 'title'),
        (bodyId) =>
          push(ctx, bodyId, 'ui:list', {
            variant: 'plain',
            items: records(p.items).map((item) =>
              compact({
                title: tr(ctx, item, 'label') ?? '',
                meta: tr(ctx, item, 'detail'),
                status: toCanonicalStatus(item.status),
              })
            ),
          }),
        children
      );
      return;

    case 'display:progress': {
      const steps = records(p.steps);
      const done = steps.filter((step) => step.status === 'done').length;
      const meterId = push(ctx, freshId(ctx, `${id}/meter`), 'ui:meter', {
        label: tr(ctx, p, 'title') ?? ctx.tx('chronos_a2ui_progress', 'Progress'),
        value: steps.length ? done : null,
        max: Math.max(1, steps.length),
      });
      const stepsId = push(ctx, freshId(ctx, `${id}/steps`), 'ui:list', {
        variant: 'timeline',
        items: steps.map((step) =>
          compact({
            title: tr(ctx, step, 'label') ?? '',
            status:
              typeof step.status === 'string' &&
              Object.prototype.hasOwnProperty.call(STEP_STATUSES, step.status)
                ? STEP_STATUSES[step.status]
                : 'pending',
          })
        ),
      });
      push(ctx, id, 'ui:stack', { gap: 'sm' }, [meterId, stepsId, ...children]);
      return;
    }

    case 'display:alert': {
      const severity = typeof p.severity === 'string' ? p.severity : 'info';
      push(
        ctx,
        id,
        'ui:callout',
        {
          tone: Object.prototype.hasOwnProperty.call(ALERT_TONES, severity)
            ? ALERT_TONES[severity]
            : 'info',
          title: tr(ctx, p, 'title') ?? '',
          body: tr(ctx, p, 'message'),
        },
        children
      );
      return;
    }

    case 'display:donut':
      push(ctx, id, 'ui:donut', {
        title: tr(ctx, p, 'title'),
        segments: chartData(p.data),
        center_label: text(p.centerLabel),
      });
      return;

    case 'display:bar-chart':
      push(ctx, id, 'ui:bar-chart', {
        title: tr(ctx, p, 'title'),
        data: chartData(p.data),
        unit: text(p.unit),
        orientation: 'horizontal',
      });
      return;

    case 'display:stacked-bar': {
      const data = chartData(p.data).filter((d) => d.value !== null && d.value > 0);
      push(ctx, id, 'ui:bar-chart', {
        title: tr(ctx, p, 'title'),
        // One unlabeled category: the title already names the bar.
        categories: [''],
        series: data.map((d) => ({ name: d.label, values: [d.value] })),
        stacked: true,
        orientation: 'horizontal',
      });
      return;
    }

    case 'display:sparkline':
      push(ctx, id, 'ui:sparkline', {
        label: tr(ctx, p, 'title'),
        points: (Array.isArray(p.points) ? p.points : []).map(num),
        unit: text(p.unit),
        show_value: true,
      });
      return;

    case 'kb-status-orbit': {
      const phases = ['intent', 'plan', 'state', 'result'] as const;
      const phaseDefaults = { intent: 'Intent', plan: 'Plan', state: 'State', result: 'Result' };
      const phaseKeys = isRecord(p.phaseKeys) ? p.phaseKeys : {};
      const current = phases.indexOf(p.currentPhase as (typeof phases)[number]);
      const status = toCanonicalStatus(p.status) ?? 'active';
      push(ctx, id, 'ui:flow', {
        title: tr(ctx, p, 'label'),
        density: 'compact',
        nodes: phases.map((phase, index) =>
          compact({
            id: phase,
            label: ctx.tx(
              text(phaseKeys[phase]) ?? A2UI_FALLBACK_KEYS[phaseDefaults[phase]],
              phaseDefaults[phase]
            ),
            status: index < current ? 'done' : index === current ? status : 'planned',
          })
        ),
        edges: [
          { from: 'intent', to: 'plan' },
          { from: 'plan', to: 'state' },
          { from: 'state', to: 'result' },
        ],
      });
      return;
    }

    case 'kb-mission-card': {
      const missionId = text(p.missionId);
      const priority = text(p.priority);
      const metaChildren: string[] = [];
      if (missionId)
        metaChildren.push(
          push(ctx, freshId(ctx, `${id}/mission-id`), 'ui:text', {
            text: missionId,
            variant: 'mono',
          })
        );
      if (priority)
        metaChildren.push(
          push(ctx, freshId(ctx, `${id}/priority`), 'ui:badge', {
            label: tr(ctx, p, 'priority') ?? priority,
            tone: Object.prototype.hasOwnProperty.call(PRIORITY_TONES, priority)
              ? PRIORITY_TONES[priority]
              : 'info',
          })
        );
      const metaId = metaChildren.length
        ? push(
            ctx,
            freshId(ctx, `${id}/meta`),
            'ui:stack',
            { gap: 'sm', direction: 'horizontal', align: 'center', wrap: true },
            metaChildren
          )
        : undefined;
      const progress = num(p.progress);
      const meterId = push(ctx, freshId(ctx, `${id}/progress`), 'ui:meter', {
        label: ctx.tx('chronos_a2ui_progress', 'Progress'),
        value: progress === null ? null : Math.min(100, Math.max(0, progress)),
        max: 100,
        unit: '%',
      });
      push(
        ctx,
        id,
        'ui:section',
        { title: tr(ctx, p, 'title'), description: tr(ctx, p, 'owner') },
        [...(metaId ? [metaId] : []), meterId, ...children]
      );
      return;
    }

    default:
      // Catalog types, chronos-local fallback types and unknown types pass
      // through (props sanitized) — the shared renderer decides.
      ctx.out.push(children.length ? { id, type, props: p, children } : { id, type, props: p });
  }
}

/**
 * Rewrite a chronos A2UI component list into `kyberion-base` components.
 * Every input component keeps its id (as the root of its expansion); new
 * ids are namespaced under it (`<id>/...`).
 */
export function expandChronosComponents(
  components: readonly ChronosA2UIComponent[],
  tx: ChronosA2UITranslate = identityTranslate
): ChronosA2UIComponent[] {
  const list = Array.isArray(components)
    ? components.filter(
        (c): c is ChronosA2UIComponent =>
          isRecord(c) && typeof c.id === 'string' && typeof c.type === 'string'
      )
    : [];
  const ctx: ExpandContext = {
    tx,
    out: [],
    used: new Set(list.map((c) => c.id)),
    depth: 0,
  };
  for (const component of list) {
    const children = Array.isArray(component.children)
      ? component.children.filter((child): child is string => typeof child === 'string')
      : [];
    expandOne(ctx, component, children);
  }
  return ctx.out;
}

/** Types the adapter rewrites into `ui:*` subtrees. */
export const CHRONOS_ADAPTED_TYPES: readonly string[] = Object.freeze([
  'display:hero',
  'display:badges',
  'display:section',
  'display:gauge',
  'display:log',
  'display:table',
  'display:status',
  'display:kv',
  'display:metric',
  'display:metrics-row',
  'display:timeline',
  'display:progress',
  'display:alert',
  'display:code',
  'display:list',
  'display:card',
  'display:grid',
  'display:donut',
  'display:bar-chart',
  'display:stacked-bar',
  'display:sparkline',
  'kb-layout-grid',
  'kb-status-orbit',
  'kb-mission-card',
]);
