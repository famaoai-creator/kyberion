/**
 * Standard catalog — renderers for the shared A2UI component types.
 *
 * Every renderer is a small pure function over the render context. Text goes
 * through text nodes only. Layout and colour come from class names that the
 * host stylesheet defines, never from inline style props, so a producer can
 * choose *what* to show and the host keeps control of *how* it looks.
 */
import { parseActionDescriptor } from './actions.js';
import type { A2UIComponent } from './protocol.js';
import type { ComponentRegistry, RenderContext } from './registry.js';

type Ctx<N> = RenderContext<N>;

const VARIANTS = new Set(['primary', 'secondary', 'danger', 'ghost']);
const TONES = new Set(['info', 'success', 'warning', 'danger', 'neutral']);

function tone(value: unknown): string {
  return typeof value === 'string' && TONES.has(value) ? value : 'neutral';
}

function entriesOf(value: unknown): Array<{ key: string; value: string; highlight: boolean }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
    )
    .map((entry) => ({
      key: String(entry.key ?? entry.label ?? ''),
      value: entry.value === undefined || entry.value === null ? '' : String(entry.value),
      highlight: entry.highlight === true,
    }));
}

function clampPercent(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function withTitle<N>(ctx: Ctx<N>, node: N, title: unknown, tag: string, className: string): void {
  const text = ctx.text(title);
  if (text) ctx.adapter.append(node, ctx.h(tag, className, text));
}

function appendAll<N>(ctx: Ctx<N>, parent: N, nodes: N[]): void {
  for (const node of nodes) ctx.adapter.append(parent, node);
}

function children<N>(component: A2UIComponent, ctx: Ctx<N>): N[] {
  return [
    ...ctx.renderChildren(component),
    ...ctx.renderInline(component, ctx.prop(component, 'items')),
  ];
}

/** Register the standard component set on `registry`. */
export function registerStandardCatalog<N>(registry: ComponentRegistry<N>): ComponentRegistry<N> {
  registry.define({
    type: 'text',
    description: 'Paragraph of text.',
    props: ['text', 'content', 'variant'],
    render: (component, ctx) => {
      const variant = ctx.text(ctx.prop(component, 'variant'));
      const text = ctx.text(ctx.prop(component, 'text') ?? ctx.prop(component, 'content'));
      return ctx.h('p', `a2ui-text${variant === 'muted' ? ' a2ui-text-muted' : ''}`, text);
    },
  });

  registry.define({
    type: 'button',
    description: 'Button that dispatches an action.',
    props: ['label', 'variant', 'action', 'disabled'],
    render: (component, ctx) => {
      const variant = ctx.text(ctx.prop(component, 'variant'));
      const button = ctx.h(
        'button',
        `a2ui-button a2ui-button-${VARIANTS.has(variant) ? variant : 'secondary'}`
      );
      ctx.adapter.setAttribute(button, 'type', 'button');
      ctx.adapter.setText(button, ctx.text(ctx.prop(component, 'label')));
      const action = parseActionDescriptor(component.props.action);
      if (!action || ctx.prop(component, 'disabled') === true) {
        ctx.adapter.setAttribute(button, 'disabled', 'disabled');
      } else {
        ctx.adapter.on(button, 'click', () => ctx.dispatch(action, component));
      }
      return button;
    },
  });

  registry.define({
    type: 'card',
    description: 'Titled box with children.',
    props: ['title', 'subtitle', 'items', 'children'],
    render: (component, ctx) => {
      const card = ctx.h('section', 'a2ui-card');
      withTitle(ctx, card, ctx.prop(component, 'title'), 'h3', 'a2ui-card-title');
      withTitle(ctx, card, ctx.prop(component, 'subtitle'), 'p', 'a2ui-card-subtitle');
      appendAll(ctx, card, children(component, ctx));
      return card;
    },
  });

  registry.define({
    type: 'container',
    description: 'Layout container; `direction` row or column.',
    props: ['direction', 'items', 'children'],
    render: (component, ctx) => {
      const direction = ctx.text(ctx.prop(component, 'direction')) === 'row' ? 'row' : 'column';
      const box = ctx.h('div', `a2ui-container a2ui-container-${direction}`);
      appendAll(ctx, box, children(component, ctx));
      return box;
    },
  });

  registry.define({
    type: 'display:hero',
    description: 'Page heading with optional subtitle.',
    props: ['title', 'subtitle'],
    render: (component, ctx) => {
      const hero = ctx.h('header', 'a2ui-hero');
      withTitle(ctx, hero, ctx.prop(component, 'title'), 'h2', 'a2ui-hero-title');
      withTitle(ctx, hero, ctx.prop(component, 'subtitle'), 'p', 'a2ui-hero-subtitle');
      return hero;
    },
  });

  registry.define({
    type: 'display:section',
    description: 'Titled section grouping children.',
    props: ['title', 'items', 'children'],
    render: (component, ctx) => {
      const section = ctx.h('section', 'a2ui-section');
      withTitle(ctx, section, ctx.prop(component, 'title'), 'h3', 'a2ui-section-title');
      appendAll(ctx, section, children(component, ctx));
      return section;
    },
  });

  registry.define({
    type: 'display:card',
    description: 'Compact card with title, body text and children.',
    props: ['title', 'body', 'tone', 'items', 'children'],
    render: (component, ctx) => {
      const card = ctx.h('section', `a2ui-card a2ui-tone-${tone(ctx.prop(component, 'tone'))}`);
      withTitle(ctx, card, ctx.prop(component, 'title'), 'h4', 'a2ui-card-title');
      withTitle(ctx, card, ctx.prop(component, 'body'), 'p', 'a2ui-card-body');
      appendAll(ctx, card, children(component, ctx));
      return card;
    },
  });

  registry.define({
    type: 'display:list',
    description: 'Bulleted list of strings or `{ label, detail }` items.',
    props: ['title', 'items'],
    render: (component, ctx) => {
      const wrap = ctx.h('div', 'a2ui-list');
      withTitle(ctx, wrap, ctx.prop(component, 'title'), 'h4', 'a2ui-minor-title');
      const list = ctx.h('ul', 'a2ui-list-items');
      const items = ctx.prop(component, 'items');
      for (const item of Array.isArray(items) ? items : []) {
        const li = ctx.h('li', 'a2ui-list-item');
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          ctx.adapter.append(
            li,
            ctx.h('span', 'a2ui-list-label', ctx.text(record.label ?? record.title ?? record.text))
          );
          if (record.detail !== undefined)
            ctx.adapter.append(li, ctx.h('span', 'a2ui-list-detail', ctx.text(record.detail)));
        } else {
          ctx.adapter.setText(li, ctx.text(item));
        }
        ctx.adapter.append(list, li);
      }
      ctx.adapter.append(wrap, list);
      return wrap;
    },
  });

  registry.define({
    type: 'display:kv',
    description: 'Key/value rows; `highlight: true` marks the active row.',
    props: ['title', 'entries'],
    render: (component, ctx) => {
      const wrap = ctx.h('div', 'a2ui-kv');
      withTitle(ctx, wrap, ctx.prop(component, 'title'), 'h4', 'a2ui-minor-title');
      const list = ctx.h('dl', 'a2ui-kv-rows');
      for (const entry of entriesOf(ctx.prop(component, 'entries'))) {
        const row = ctx.h('div', `a2ui-kv-row${entry.highlight ? ' a2ui-kv-row-highlight' : ''}`);
        ctx.adapter.append(row, ctx.h('dt', 'a2ui-kv-key', entry.key));
        ctx.adapter.append(row, ctx.h('dd', 'a2ui-kv-value', entry.value));
        ctx.adapter.append(list, row);
      }
      ctx.adapter.append(wrap, list);
      return wrap;
    },
  });

  registry.define({
    type: 'display:progress',
    description: 'Progress bar from `value`/`max`, `percent`, or `steps` (`{ label, status }`).',
    props: ['label', 'title', 'value', 'max', 'percent', 'steps'],
    render: (component, ctx) => {
      const value = ctx.prop(component, 'value');
      const max = ctx.prop(component, 'max');
      const rawSteps = ctx.prop(component, 'steps');
      const steps = (Array.isArray(rawSteps) ? rawSteps : [])
        .filter(
          (step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object'
        )
        .map((step) => ({
          label: ctx.text(step.label ?? step.title),
          status:
            typeof step.status === 'string' && /^[a-z_-]{1,24}$/u.test(step.status)
              ? step.status
              : 'pending',
        }));
      const doneSteps = steps.filter(
        (step) => step.status === 'done' || step.status === 'complete'
      ).length;
      const percent = steps.length
        ? clampPercent((doneSteps / steps.length) * 100)
        : typeof value === 'number' && typeof max === 'number' && max > 0
          ? clampPercent((value / max) * 100)
          : clampPercent(ctx.prop(component, 'percent'));
      const wrap = ctx.h('div', 'a2ui-progress');
      const head = ctx.h('div', 'a2ui-progress-head');
      ctx.adapter.append(
        head,
        ctx.h(
          'span',
          'a2ui-progress-label',
          ctx.text(ctx.prop(component, 'label') ?? ctx.prop(component, 'title'))
        )
      );
      ctx.adapter.append(head, ctx.h('span', 'a2ui-progress-value', `${percent}%`));
      ctx.adapter.append(wrap, head);
      const track = ctx.h('div', 'a2ui-progress-track');
      ctx.adapter.setAttribute(track, 'role', 'progressbar');
      ctx.adapter.setAttribute(track, 'aria-valuenow', String(percent));
      ctx.adapter.setAttribute(track, 'aria-valuemin', '0');
      ctx.adapter.setAttribute(track, 'aria-valuemax', '100');
      const fill = ctx.h(
        'div',
        `a2ui-progress-fill a2ui-progress-fill-${Math.round(percent / 10) * 10}`
      );
      ctx.adapter.append(track, fill);
      ctx.adapter.append(wrap, track);
      if (steps.length) {
        const list = ctx.h('ol', 'a2ui-progress-steps');
        for (const step of steps) {
          const item = ctx.h(
            'li',
            `a2ui-progress-step a2ui-progress-step-${step.status}`,
            step.label
          );
          ctx.adapter.setAttribute(item, 'data-status', step.status);
          ctx.adapter.append(list, item);
        }
        ctx.adapter.append(wrap, list);
      }
      return wrap;
    },
  });

  registry.define({
    type: 'display:alert',
    description: 'Callout with tone info/success/warning/danger.',
    props: ['title', 'message', 'tone'],
    render: (component, ctx) => {
      const box = ctx.h('div', `a2ui-alert a2ui-tone-${tone(ctx.prop(component, 'tone'))}`);
      ctx.adapter.setAttribute(box, 'role', 'note');
      withTitle(ctx, box, ctx.prop(component, 'title'), 'strong', 'a2ui-alert-title');
      withTitle(
        ctx,
        box,
        ctx.prop(component, 'message') ?? ctx.prop(component, 'text'),
        'p',
        'a2ui-alert-message'
      );
      return box;
    },
  });

  registry.define({
    type: 'display:badges',
    description: 'Row of small labels; items are strings or `{ label, tone }`.',
    props: ['items'],
    render: (component, ctx) => {
      const row = ctx.h('div', 'a2ui-badges');
      const items = ctx.prop(component, 'items');
      for (const item of Array.isArray(items) ? items : []) {
        const record: Record<string, unknown> =
          item && typeof item === 'object' ? (item as Record<string, unknown>) : { label: item };
        ctx.adapter.append(
          row,
          ctx.h('span', `a2ui-badge a2ui-tone-${tone(record.tone)}`, ctx.text(record.label))
        );
      }
      return row;
    },
  });

  registry.define({
    type: 'display:status',
    description: 'Status dot with label and optional detail.',
    props: ['label', 'state', 'detail'],
    render: (component, ctx) => {
      const state = ctx.text(ctx.prop(component, 'state')) || 'unknown';
      const wrap = ctx.h('div', 'a2ui-status');
      const dot = ctx.h(
        'span',
        `a2ui-status-dot a2ui-status-${/^[a-z_-]{1,24}$/u.test(state) ? state : 'unknown'}`
      );
      ctx.adapter.append(wrap, dot);
      ctx.adapter.append(
        wrap,
        ctx.h('span', 'a2ui-status-label', ctx.text(ctx.prop(component, 'label')))
      );
      const detail = ctx.text(ctx.prop(component, 'detail'));
      if (detail) ctx.adapter.append(wrap, ctx.h('span', 'a2ui-status-detail', detail));
      return wrap;
    },
  });

  registry.define({
    type: 'display:metric',
    description: 'Single number with label and unit.',
    props: ['label', 'value', 'unit', 'tone'],
    render: (component, ctx) => {
      const box = ctx.h('div', `a2ui-metric a2ui-tone-${tone(ctx.prop(component, 'tone'))}`);
      ctx.adapter.append(
        box,
        ctx.h('span', 'a2ui-metric-value', ctx.text(ctx.prop(component, 'value')))
      );
      const unit = ctx.text(ctx.prop(component, 'unit'));
      if (unit) ctx.adapter.append(box, ctx.h('span', 'a2ui-metric-unit', unit));
      ctx.adapter.append(
        box,
        ctx.h('span', 'a2ui-metric-label', ctx.text(ctx.prop(component, 'label')))
      );
      return box;
    },
  });

  registry.define({
    type: 'display:metrics-row',
    description: 'Row of metrics from `items` or children.',
    props: ['items', 'children'],
    render: (component, ctx) => {
      const row = ctx.h('div', 'a2ui-metrics-row');
      appendAll(ctx, row, children(component, ctx));
      return row;
    },
  });

  registry.define({
    type: 'display:table',
    description: 'Table from `columns` (strings or `{ key, label }`) and `rows`.',
    props: ['title', 'columns', 'rows'],
    render: (component, ctx) => {
      const wrap = ctx.h('div', 'a2ui-table-wrap');
      withTitle(ctx, wrap, ctx.prop(component, 'title'), 'h4', 'a2ui-minor-title');
      const table = ctx.h('table', 'a2ui-table');
      const rawColumns = ctx.prop(component, 'columns');
      const columns = (Array.isArray(rawColumns) ? rawColumns : []).map((column) =>
        column && typeof column === 'object'
          ? {
              key: String((column as Record<string, unknown>).key ?? ''),
              label: ctx.text((column as Record<string, unknown>).label),
            }
          : { key: String(column), label: String(column) }
      );
      const head = ctx.h('thead');
      const headRow = ctx.h('tr');
      for (const column of columns)
        ctx.adapter.append(headRow, ctx.h('th', 'a2ui-table-th', column.label));
      ctx.adapter.append(head, headRow);
      ctx.adapter.append(table, head);
      const body = ctx.h('tbody');
      const rows = ctx.prop(component, 'rows');
      for (const row of Array.isArray(rows) ? rows : []) {
        const tr = ctx.h('tr');
        if (Array.isArray(row)) {
          for (const cell of row)
            ctx.adapter.append(tr, ctx.h('td', 'a2ui-table-td', ctx.text(cell)));
        } else if (row && typeof row === 'object') {
          for (const column of columns) {
            ctx.adapter.append(
              tr,
              ctx.h('td', 'a2ui-table-td', ctx.text((row as Record<string, unknown>)[column.key]))
            );
          }
        }
        ctx.adapter.append(body, tr);
      }
      ctx.adapter.append(table, body);
      ctx.adapter.append(wrap, table);
      return wrap;
    },
  });

  registry.define({
    type: 'display:code',
    description: 'Preformatted text block.',
    props: ['title', 'code', 'language'],
    render: (component, ctx) => {
      const wrap = ctx.h('div', 'a2ui-code');
      withTitle(ctx, wrap, ctx.prop(component, 'title'), 'h4', 'a2ui-minor-title');
      const pre = ctx.h('pre', 'a2ui-code-block');
      const code = ctx.h(
        'code',
        undefined,
        ctx.text(ctx.prop(component, 'code') ?? ctx.prop(component, 'text'))
      );
      const language = ctx.text(ctx.prop(component, 'language'));
      if (language) ctx.adapter.setAttribute(code, 'data-language', language);
      ctx.adapter.append(pre, code);
      ctx.adapter.append(wrap, pre);
      return wrap;
    },
  });

  registry.define({
    type: 'display:timeline',
    description: 'Ordered events `{ at, label, detail, tone }`.',
    props: ['title', 'items'],
    render: (component, ctx) => {
      const wrap = ctx.h('div', 'a2ui-timeline');
      withTitle(ctx, wrap, ctx.prop(component, 'title'), 'h4', 'a2ui-minor-title');
      const list = ctx.h('ol', 'a2ui-timeline-items');
      const items = ctx.prop(component, 'items');
      for (const item of Array.isArray(items) ? items : []) {
        const record: Record<string, unknown> =
          item && typeof item === 'object' ? (item as Record<string, unknown>) : { label: item };
        const li = ctx.h('li', `a2ui-timeline-item a2ui-tone-${tone(record.tone)}`);
        const at = ctx.text(record.at ?? record.time);
        if (at) ctx.adapter.append(li, ctx.h('time', 'a2ui-timeline-at', at));
        ctx.adapter.append(
          li,
          ctx.h('span', 'a2ui-timeline-label', ctx.text(record.label ?? record.title))
        );
        const detail = ctx.text(record.detail);
        if (detail) ctx.adapter.append(li, ctx.h('span', 'a2ui-timeline-detail', detail));
        ctx.adapter.append(list, li);
      }
      ctx.adapter.append(wrap, list);
      return wrap;
    },
  });

  registry.define({
    type: 'display:log',
    description: 'Monospace log lines from `lines` or `items`.',
    props: ['title', 'lines', 'items'],
    render: (component, ctx) => {
      const wrap = ctx.h('div', 'a2ui-log');
      withTitle(ctx, wrap, ctx.prop(component, 'title'), 'h4', 'a2ui-minor-title');
      const pre = ctx.h('pre', 'a2ui-log-lines');
      const lines = ctx.prop(component, 'lines') ?? ctx.prop(component, 'items');
      ctx.adapter.setText(
        pre,
        (Array.isArray(lines) ? lines : []).map((line) => ctx.text(line)).join('\n')
      );
      ctx.adapter.append(wrap, pre);
      return wrap;
    },
  });

  return registry;
}
