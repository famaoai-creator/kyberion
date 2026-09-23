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
  // UI-01c settings & forms
  'ui:settings-group': { title: '通知', description: 'いつ知らせるか' },
  'ui:setting-row': { label: 'メール通知', description: '承認待ちを知らせる', tone: 'neutral' },
  'ui:switch': { name: 'notify.email', label: 'メール通知', value: true, hide_label: true },
  'ui:checkbox': { name: 'agree', label: '同意する', value: false, required: true },
  'ui:select': {
    name: 'lang',
    label: '言語',
    value: 'ja',
    options: [
      { value: 'ja', label: '日本語' },
      { value: 'en', label: 'English' },
    ],
    placeholder: '選択',
  },
  'ui:radio-group': {
    name: 'plan',
    label: 'プラン',
    options: [{ value: 'a', label: 'A', description: '基本' }],
    direction: 'horizontal',
  },
  'ui:segmented': {
    name: 'density',
    label: '表示密度',
    value: 'compact',
    options: [
      { value: 'comfortable', label: 'ゆったり' },
      { value: 'compact', label: 'コンパクト' },
    ],
  },
  'ui:text-field': {
    name: 'email',
    label: 'メール',
    type: 'email',
    value: 'a@example.com',
    help: '通知の宛先',
    error: '形式が正しくありません',
    required: true,
    maxlength: 120,
  },
  'ui:textarea': { name: 'bio', label: '自己紹介', rows: 4, maxlength: 400, value: '' },
  'ui:slider': { name: 'volume', label: '音量', value: 40, min: 0, max: 100, step: 5, unit: '%' },
  'ui:integration-item': {
    title: 'Google Workspace',
    state: 'needs_reauth',
    detail: 'a@example.com',
    actions: [{ label: '再接続', action: { id: 'oauth.begin', payload: { service: 'google' } } }],
  },
  'ui:save-bar': {
    state: 'dirty',
    save_action: { id: 'settings.save' },
    discard_action: { id: 'settings.discard' },
  },
  'ui:file-drop': {
    name: 'docs',
    label: '資料',
    accept: '.pdf,.docx,image/*',
    multiple: true,
    max_bytes: 26214400,
    files: [{ id: 'f1', name: 'a.pdf', size: 1024, status: 'uploading', progress: 40 }],
    action: { id: 'ingest.add' },
  },
  'ui:camera-capture': { name: 'photo', label: '撮影', facing: 'user', aspect: 'square' },
  'ui:avatar-picker': {
    name: 'avatar',
    label: 'アバター',
    image_url: '/api/avatar',
    initials: 'KB',
    removable: true,
  },
  'ui:secret-field': {
    name: 'openai',
    label: 'API トークン',
    configured: true,
    last4: 'x9Qa',
    service_id: 'openai',
    secret_key: 'api_key',
    action: { id: 'secret.introduce' },
    remove_action: { id: 'secret.remove' },
  },
  // UI-01b charts & visualisation
  'ui:bar-chart': {
    title: '週次の件数',
    categories: ['月', '火'],
    series: [{ name: '承認', values: [3, null] }],
    orientation: 'horizontal',
    stacked: false,
  },
  'ui:line-chart': {
    series: [
      {
        name: '応答',
        points: [
          { x: '09:00', y: 1.2 },
          { x: '10:00', y: null },
        ],
      },
    ],
    area: true,
    y_unit: 's',
  },
  'ui:donut': { segments: [{ label: '完了', value: 4 }], center_label: '合計' },
  'ui:sparkline': { points: [1, 3, null, 2], tone: 'accent' },
  'ui:heatmap': { rows: ['月'], columns: ['9時'], values: [[2]], scale: 'sequential' },
  'ui:meter': { label: '予算', value: 72, max: 100, thresholds: [{ value: 80, tone: 'warning' }] },
  'ui:sequence': {
    participants: ['user', { id: 'agent', label: '相棒' }],
    messages: [
      { from: 'user', to: 'agent', label: '依頼', at: '09:00', status: 'done', kind: 'call' },
    ],
  },
  'ui:flow': {
    nodes: [
      { id: 'm', label: 'ミッション', stage: 'mission', status: 'active' },
      { id: 't', label: 'タスク', stage: 'task' },
    ],
    edges: [{ from: 'm', to: 't', label: '分解' }],
    stages: [{ id: 'mission', label: 'ミッション' }, 'task'],
  },
  'ui:stat-list': { items: [{ label: '中央値', value: 1.4, unit: 's', hint: 'p50' }] },
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
