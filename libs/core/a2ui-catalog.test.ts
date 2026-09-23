import { describe, expect, it } from 'vitest';
import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import { validateA2UIMessage } from './a2ui.js';
import {
  KB_STATUS_TONES,
  KB_STATUS_VALUES,
  A2UI_BASE_ALIASES,
  A2UI_BASE_CATALOG_ID,
  A2UI_BASE_COMPONENT_TYPES,
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
    brand: { name: 'Kyberion', subtitle: 'あなたの秘書室', logo_url: '/logo.svg' },
    context: {
      label: '既定のテナント',
      detail: 'オーナー · 2 件から切替',
      switch_label: 'テナントを切り替える',
      action: { id: 'tenant.switch' },
      options: [
        { value: 'default', label: '既定のテナント', selected: true },
        { value: 'acme', label: 'Acme' },
      ],
    },
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
    items: [
      { title: 'build', meta: '10:02', status: 'completed', href: '/t/1' },
      { title: 'deploy', status: 'active', status_label: '進行中', progress: 40 },
    ],
    variant: 'timeline',
  },
  'ui:text': { text: 'hello', variant: 'muted' },
  'ui:code': { code: 'pnpm build\n  ok', language: 'shell', title: 'ビルド' },
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
  'ui:display-controls': {
    theme: 'dark',
    locale: 'ja',
    locales: [
      { value: 'ja', label: '日本語' },
      { value: 'en', label: 'English' },
    ],
  },
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
  // PA-02 voice
  'ui:voice-input': {
    name: 'memo',
    label: '音声メモ',
    mode: 'record',
    lang: 'ja-JP',
    push_to_talk: true,
    show_level: true,
    chunk_ms: 1000,
    max_seconds: 60,
    status: 'transcribing',
    help: '話し終えたら離してください',
    actions: { recording: { id: 'memo.audio', payload: { pad: 'notes' } } },
  },
  'ui:voice-state': { state: 'speaking', level: 0.4, variant: 'orb', size: 'lg' },
  // PA-01 pads
  'ui:toolbar': {
    label: 'レビュー',
    sticky: true,
    density: 'compact',
    items: [
      { type: 'button', id: 'save', label: '保存', icon: '💾', variant: 'primary' },
      { type: 'toggle', id: 'comments', label: 'コメント', pressed: true, hide_label: true },
      { type: 'file', id: 'import', label: '読み込む', accept: '.md,image/*', multiple: true },
      { type: 'separator' },
      { type: 'spacer' },
      { type: 'status', id: 'saved', text: '保存しました', tone: 'success' },
    ],
  },
  'ui:dialog': {
    open: true,
    title: '名前を付ける',
    message: 'ファイル名を入力',
    tone: 'neutral',
    input: {
      name: 'file',
      label: 'ファイル名',
      placeholder: 'notes',
      value: 'a',
      multiline: false,
    },
    confirm_label: '保存',
    cancel_label: 'やめる',
    action: { id: 'file.rename' },
    cancel_action: { id: 'file.rename.cancel' },
  },
  'ui:drawing-palette': {
    name: 'pen',
    label: '描画パレット',
    tools: ['pen', 'highlighter', 'text'],
    tool: 'pen',
    colors: ['#e5484d', '#0af'],
    color: '#0af',
    allow_custom_color: true,
    width: 6,
    min_width: 2,
    max_width: 30,
    can_undo: true,
    show_clear: true,
    orientation: 'vertical',
  },
  'ui:sketch-board': {
    name: 'sketch',
    label: 'スケッチ',
    tools: ['pen', 'rect', 'text', 'eraser'],
    default_tool: 'rect',
    default_color: '#30a46c',
    default_width: 3,
    canvas_width: 800,
    canvas_height: 600,
    background: 'light',
    background_image_url: '/api/screenshot.png',
    accept_image_drop: true,
    max_undo: 40,
    show_download: true,
  },
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
    expect(propsDefs).toEqual([...A2UI_BASE_COMPONENT_TYPES].sort());
    expect([...schema.properties.type.enum].sort()).toEqual([...A2UI_BASE_COMPONENT_TYPES].sort());
    expect(A2UI_BASE_CATALOG_ID).toBe('kyberion-base');
  });

  it.each(A2UI_BASE_COMPONENT_TYPES)('accepts a valid %s example', (type) => {
    expect(() => validateA2UIComponentProps(type, VALID_EXAMPLES[type])).not.toThrow();
  });

  it.each(A2UI_BASE_COMPONENT_TYPES)('rejects unknown props on %s', (type) => {
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

  it('bounds the nav-rail slots, list progress and display-controls values', () => {
    expect(() =>
      validateA2UIComponentProps('ui:nav-rail', { items: [], brand: { subtitle: 'x' } })
    ).toThrow(/name/u);
    expect(() =>
      validateA2UIComponentProps('ui:nav-rail', {
        items: [],
        context: { label: 't', href: 'javascript:alert(1)' },
      })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:list', { items: [{ title: 'x', progress: 140 }] })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:list', { items: [{ title: 'x', status_label: '' }] })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:display-controls', { theme: 'sepia' })).toThrow(
      /theme/u
    );
    expect(() => validateA2UIComponentProps('ui:display-controls', {})).not.toThrow();
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

  // PA-02 voice
  it('bounds the voice-input / voice-state props (no audio or transcript slots)', () => {
    const base = { name: 'memo', label: 'Memo' };
    expect(() => validateA2UIComponentProps('ui:voice-input', base)).not.toThrow();
    expect(() => validateA2UIComponentProps('ui:voice-input', { ...base, mode: 'stream' })).toThrow(
      /mode/u
    );
    expect(() =>
      validateA2UIComponentProps('ui:voice-input', { ...base, lang: 'ja JP' })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:voice-input', { ...base, chunk_ms: 10 })).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:voice-input', { ...base, max_seconds: 0 })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:voice-input', { ...base, status: 'recording' })
    ).toThrow(/status/u);
    expect(() =>
      validateA2UIComponentProps('ui:voice-input', { ...base, transcript: 'hello' })
    ).toThrow(/transcript/u);
    expect(() =>
      validateA2UIComponentProps('ui:voice-input', { ...base, actions: { audio: { id: 'x' } } })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:voice-state', {})).toThrow(/state/u);
    expect(() => validateA2UIComponentProps('ui:voice-state', { state: 'talking' })).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:voice-state', { state: 'idle', level: 1.5 })
    ).toThrow();
  });

  // PA-01 pads
  it('bounds the toolbar / dialog / drawing props (no file or image data slots)', () => {
    const toolbar = (item: Record<string, unknown>) =>
      validateA2UIComponentProps('ui:toolbar', { label: 'T', items: [item] });
    expect(() => toolbar({ type: 'button', id: 'a' })).toThrow(/label/u);
    expect(() => toolbar({ type: 'status', id: 's' })).toThrow(/text/u);
    expect(() => toolbar({ type: 'menu', id: 'a', label: 'A' })).toThrow();
    expect(() => toolbar({ type: 'file', id: 'f', label: 'F', files: [] })).toThrow(/files/u);
    expect(() => toolbar({ type: 'separator' })).not.toThrow();
    expect(() => validateA2UIComponentProps('ui:toolbar', { items: [] })).toThrow(/label/u);
    expect(() => validateA2UIComponentProps('ui:dialog', { title: 'x' })).toThrow(/open/u);
    expect(() =>
      validateA2UIComponentProps('ui:dialog', { open: false, title: 'x', tone: 'warning' })
    ).toThrow(/tone/u);
    expect(() =>
      validateA2UIComponentProps('ui:dialog', {
        open: true,
        title: 'x',
        choices: [{ id: 'save', label: 'Save', variant: 'primary' }],
      })
    ).not.toThrow();
    const palette = { name: 'p', label: 'P' };
    expect(() => validateA2UIComponentProps('ui:drawing-palette', palette)).not.toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:drawing-palette', { ...palette, tool: 'spray' })
    ).toThrow(/tool/u);
    expect(() =>
      validateA2UIComponentProps('ui:drawing-palette', { ...palette, color: 'red' })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:drawing-palette', { ...palette, width: 0 })
    ).toThrow();
    const board = { name: 's', label: 'S' };
    expect(() =>
      validateA2UIComponentProps('ui:sketch-board', {
        ...board,
        background_image_url: 'data:image/png;base64,AAAA',
      })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:sketch-board', { ...board, canvas_width: 10 })
    ).toThrow();
    expect(() => validateA2UIComponentProps('ui:sketch-board', { ...board, image: 'x' })).toThrow(
      /image/u
    );
  });

  it('resolves legacy aliases and leaves non-catalog types alone', () => {
    expect(A2UI_BASE_ALIASES).toEqual({
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
