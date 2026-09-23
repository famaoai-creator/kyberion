import { describe, expect, it } from 'vitest';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { validateA2UIMessage } from './a2ui.js';
import {
  KB_STATUS_TONES,
  KB_STATUS_VALUES,
  KYBERION_BASE_ALIASES,
  KYBERION_BASE_CATALOG_ID,
  KYBERION_BASE_COMPONENT_TYPES,
  resolveKyberionBaseType,
  validateA2UIComponentProps,
  type KyberionBaseComponentType,
} from './a2ui-catalog.js';
import { listUxStatusValues } from './ux-vocabulary.js';

const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/a2ui-catalog-kyberion-base.schema.json'
);

const VALID_EXAMPLES: Record<KyberionBaseComponentType, Record<string, unknown>> = {
  'ui:app-shell': { density: 'compact', theme: 'system', role: 'chronos-mirror-v2' },
  'ui:page-header': {
    title: '管制塔',
    subtitle: 'ミッションの状況',
    role_badge: { label: '管制塔', role: 'chronos-mirror-v2' },
    actions: [{ label: '新規', href: '/missions/new', variant: 'primary' }],
  },
  'ui:nav-rail': {
    items: [{ id: 'home', label: 'ホーム', href: '/', active: true, icon: 'home' }],
    footer_items: [{ id: 'settings', label: '設定', href: '/settings' }],
  },
  'ui:tabs': { items: [{ id: 'work', label: '仕事', count: 3 }], active: 'work', overflow: 'menu' },
  'ui:stack': { gap: 'md', direction: 'horizontal', align: 'center', wrap: true },
  'ui:grid': { gap: 'lg', columns: 3 },
  'ui:section': { title: '承認待ち', tone: 'warning' },
  'ui:next-action': {
    eyebrow: '次の一手',
    title: '承認を 2 件確認する',
    reason: '期限が今日です',
    primary: { label: '確認する', action: { id: 'approvals.open' } },
    state: 'ready',
  },
  'ui:metric': { label: '進行中', value: 4, unit: '件', delta: '+1', trend: 'up' },
  'ui:kv': { items: [{ label: 'mission', value: 'MSN-1', mono: true }] },
  'ui:table': {
    columns: [
      { key: 'id', label: 'ID', mono: true, width: '12ch' },
      { key: 'count', label: '件数', align: 'end' },
    ],
    rows: [{ id: 'MSN-1', count: 2, href: '/m/1' }],
    row_href_key: 'href',
    empty: 'まだありません',
  },
  'ui:list': {
    items: [{ title: 'build', meta: '10:02', status: 'completed', href: '/t/1' }],
    variant: 'timeline',
  },
  'ui:text': { text: 'hello', variant: 'muted' },
  'ui:status-pill': { status: 'n/a', domain: 'connection', label: '該当なし' },
  'ui:badge': { label: '読み取り専用', tone: 'neutral' },
  'ui:callout': { tone: 'danger', title: '接続できません', body: '再試行してください' },
  'ui:empty-state': {
    title: 'まだ何もありません',
    action: { label: '始める', href: '/start' },
  },
  'ui:skeleton': { lines: 3, shape: 'table' },
  'ui:button': { label: '保存', variant: 'secondary', action: { id: 'save', payload: { a: 1 } } },
  'ui:disclosure': { summary: '開発者向け', open: false },
};

describe('kyberion-base A2UI catalog', () => {
  it('declares a props schema for every catalog type and nothing else', () => {
    const schema = readJson<{
      $defs: Record<string, unknown>;
      properties: { type: { enum: string[] } };
    }>(SCHEMA_PATH);
    const propsDefs = Object.keys(schema.$defs)
      .filter((key) => key.startsWith('props:'))
      .map((key) => key.slice('props:'.length))
      .sort();
    expect(propsDefs).toEqual([...KYBERION_BASE_COMPONENT_TYPES].sort());
    expect([...schema.properties.type.enum].sort()).toEqual(
      [...KYBERION_BASE_COMPONENT_TYPES].sort()
    );
    expect(KYBERION_BASE_CATALOG_ID).toBe('kyberion-base');
  });

  it.each(KYBERION_BASE_COMPONENT_TYPES)('accepts a valid %s example', (type) => {
    expect(() => validateA2UIComponentProps(type, VALID_EXAMPLES[type])).not.toThrow();
  });

  it.each(KYBERION_BASE_COMPONENT_TYPES)('rejects unknown props on %s', (type) => {
    expect(() =>
      validateA2UIComponentProps(type, { ...VALID_EXAMPLES[type], style: 'color: red' })
    ).toThrow(/props are invalid.*style/u);
  });

  it('rejects wrong enum values', () => {
    expect(() =>
      validateA2UIComponentProps('ui:button', { label: 'x', variant: 'neon', href: '/' })
    ).toThrow(/variant/u);
    expect(() => validateA2UIComponentProps('ui:status-pill', { status: 'green' })).toThrow(
      /status/u
    );
    expect(() =>
      validateA2UIComponentProps('ui:callout', { tone: 'accent', title: 'x' })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:app-shell', { density: 'cozy' })).toThrow();
  });

  it('enforces link/action and state-dependent requirements', () => {
    expect(() => validateA2UIComponentProps('ui:button', { label: 'x' })).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:button', { label: 'x', href: '/', action: { id: 'a' } })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:button', { label: 'x', href: 'javascript:alert(1)' })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:next-action', { title: 'x' })).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:next-action', { title: 'x', state: 'loading' })
    ).not.toThrow();
  });

  it('resolves legacy aliases and leaves non-catalog types alone', () => {
    expect(KYBERION_BASE_ALIASES).toEqual({
      text: 'ui:text',
      button: 'ui:button',
      card: 'ui:section',
      container: 'ui:stack',
    });
    expect(resolveKyberionBaseType('card')).toBe('ui:section');
    expect(resolveKyberionBaseType('ui:metric')).toBe('ui:metric');
    expect(resolveKyberionBaseType('display:metric')).toBeNull();
    expect(resolveKyberionBaseType('constructor')).toBeNull();
  });

  it('reuses the dashboard status vocabulary and maps every status to a tone', () => {
    expect([...KB_STATUS_VALUES].sort()).toEqual(listUxStatusValues());
    const schema = readJson<{ $defs: { status: { enum: string[] } } }>(SCHEMA_PATH);
    expect([...schema.$defs.status.enum].sort()).toEqual(listUxStatusValues());
    expect(Object.keys(KB_STATUS_TONES).sort()).toEqual(listUxStatusValues());
  });
});

describe('validateA2UIMessage with the catalog', () => {
  const message = (components: unknown[]) => ({
    updateComponents: { surfaceId: 'surface-1', components },
  });

  it('validates ui:* props inside updateComponents', () => {
    expect(() =>
      validateA2UIMessage(
        message([{ id: 'm1', type: 'ui:metric', props: VALID_EXAMPLES['ui:metric'] }])
      )
    ).not.toThrow();
    expect(() =>
      validateA2UIMessage(message([{ id: 'm1', type: 'ui:metric', props: { label: 'x' } }]))
    ).toThrow(/ui:metric props are invalid/u);
  });

  it('keeps existing display:*, kb-*, presence.* and legacy alias messages valid', () => {
    expect(() =>
      validateA2UIMessage(
        message([
          { id: 'a', type: 'display:metric', props: { label: 'x', value: 1, anything: true } },
          { id: 'b', type: 'display:table', props: { headers: ['a'], rows: [['1']] } },
          { id: 'c', type: 'kb-mission-card', props: { mission: {} } },
          { id: 'd', type: 'presence.subtitle', props: { text: 'hi' } },
          { id: 'e', type: 'text', props: { value: 'hello' } },
          { id: 'f', type: 'container', props: {}, children: ['a', 'b'] },
        ])
      )
    ).not.toThrow();
  });
});
