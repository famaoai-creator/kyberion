// Surface UI unification, final shared-ui round: rich table cells, secondary
// tabs, section action ids / React onClick refs, AppShell pass-through,
// meter direction, status glyph families, display-controls endonyms.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getUiMessageBundle } from '@agent/core';
import {
  KB_STATUS_FAMILIES,
  KB_STATUS_FAMILY_GLYPHS,
  KB_STATUS_VALUES,
  validateA2UIComponentProps,
} from '@agent/core/a2ui-catalog';
import { renderStatusFamilyGlyphRules } from '../../../scripts/design-token-utils.js';
import { KB_STATUS_GLYPHS, layoutChart } from '../vanilla/charts.js';
import {
  createTranslator,
  displayLocaleProps,
  localeEndonym,
  renderComponent,
} from '../vanilla/kyberion-ui.js';
import { MiniDocument, type MiniElement } from '../vanilla/mini-dom.test-support.js';
import {
  A2UIActionProvider,
  AppShell,
  Button,
  DisplayControls,
  KbI18nProvider,
  Section,
  Table,
  Tabs,
  customPropertiesOnly,
} from './index.js';

const html = renderToStaticMarkup;

const RICH_TABLE = {
  columns: [
    { key: 'mission', label: 'Mission' },
    { key: 'state', label: 'State' },
    { key: 'tier', label: 'Tier' },
  ],
  rows: [
    {
      mission: { title: 'Quote', id: 'MSN-1', href: '/missions/MSN-1' },
      state: { status: 'running' as const, label: 'In progress', domain: 'mission' as const },
      tier: { badge: 'Confidential', tone: 'warning' as const },
    },
  ],
};

describe('ui:table rich cells', () => {
  it('schema accepts title / status / badge cells and rejects unknown shapes', () => {
    expect(() => validateA2UIComponentProps('ui:table', RICH_TABLE)).not.toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:table', {
        columns: [{ key: 'a', label: 'A' }],
        rows: [{ a: { title: 'x', color: 'red' } }],
      })
    ).toThrow();
    expect(() =>
      validateA2UIComponentProps('ui:table', {
        columns: [{ key: 'a', label: 'A' }],
        rows: [{ a: { status: 'not-a-status' } }],
      })
    ).toThrow();
  });

  it('React renders title + mono id, status pill and badge', () => {
    const out = html(<Table {...RICH_TABLE} />);
    expect(out).toContain('class="kb-table__cell"');
    expect(out).toContain('<a href="/missions/MSN-1" class="kb-table__title">Quote</a>');
    expect(out).toContain('<span class="kb-table__id">MSN-1</span>');
    expect(out).toMatch(/kb-status-pill" data-status="running" data-domain="mission"/);
    expect(out).toContain('In progress');
    expect(out).toMatch(/class="kb-badge" data-tone="warning">Confidential/);
  });

  it('vanilla renders the same rich cell markup', () => {
    const document = new MiniDocument();
    const node = renderComponent(
      { id: 't', type: 'ui:table', props: RICH_TABLE },
      { document: document as unknown as Document }
    ) as unknown as MiniElement;
    expect(node.query('.kb-table__title')?.getAttribute('href')).toBe('/missions/MSN-1');
    expect(node.query('.kb-table__id')?.textContent).toBe('MSN-1');
    expect(node.query('.kb-status-pill')?.getAttribute('data-status')).toBe('running');
    expect(node.query('.kb-badge')?.textContent).toBe('Confidential');
  });

  it('React accepts element cells and renderCell (React-only)', () => {
    const out = html(
      <Table
        columns={[
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ]}
        rows={[{ a: <em>node</em>, b: 'plain' }]}
        renderCell={({ column, value }) =>
          column.key === 'b' ? <strong>{String(value)}!</strong> : undefined
        }
      />
    );
    expect(out).toContain('<em>node</em>');
    expect(out).toContain('<strong>plain!</strong>');
  });
});

describe('ui:tabs variant', () => {
  it('secondary adds data-variant; primary adds nothing', () => {
    const items = [{ id: 'a', label: 'A', href: '#a' }];
    expect(html(<Tabs items={items} active="a" variant="secondary" />)).toContain(
      'data-variant="secondary"'
    );
    expect(html(<Tabs items={items} active="a" />)).not.toContain('data-variant');
    expect(() =>
      validateA2UIComponentProps('ui:tabs', { items, variant: 'secondary' })
    ).not.toThrow();
    expect(() => validateA2UIComponentProps('ui:tabs', { items, variant: 'tertiary' })).toThrow();
  });
});

describe('ui:section actions', () => {
  it('accepts a bare action id in the schema and dispatches it through the provider', () => {
    const props = { title: 'S', actions: [{ label: 'Refresh', action: 'section.refresh' }] };
    expect(() => validateA2UIComponentProps('ui:section', props)).not.toThrow();
    const out = html(<Section {...props} />);
    expect(out).toContain('data-action-id="section.refresh"');
  });

  it('React-only onClick refs render as buttons', () => {
    const onClick = vi.fn();
    const out = html(<Section title="S" actions={[{ label: 'Go', onClick }]} />);
    expect(out).toMatch(/<button type="button" class="kb-btn kb-btn--secondary">Go<\/button>/);
  });

  it('Button normalizes a string action id', () => {
    const out = html(
      <A2UIActionProvider onAction={() => undefined}>
        <Button label="X" action="x.go" />
      </A2UIActionProvider>
    );
    expect(out).toContain('data-action-id="x.go"');
  });
});

describe('AppShell pass-through', () => {
  it('adds className and only custom-property styles', () => {
    const out = html(
      <AppShell
        className="tenant-brand"
        style={{ '--brand-accent': '#123456', color: 'red' } as never}
      >
        x
      </AppShell>
    );
    expect(out).toContain('class="kb-app-shell tenant-brand"');
    expect(out).toContain('--brand-accent:#123456');
    expect(out).not.toContain('color:red');
    expect(customPropertiesOnly({ '--x': 1, background: 'red' })).toEqual({ '--x': 1 });
    expect(customPropertiesOnly({ background: 'red' })).toBeUndefined();
  });
});

describe('ui:meter direction', () => {
  const en = getUiMessageBundle('en');
  const env = { t: createTranslator({ messages: en.messages }), locale: 'en' };
  const text = (node: unknown): string => {
    if (!node || typeof node !== 'object') return '';
    const n = node as { text?: string; children?: unknown[] };
    return (n.text ?? '') + (n.children || []).map(text).join('');
  };
  const thresholds = [
    { value: 0, tone: 'danger' },
    { value: 50, tone: 'warning' },
    { value: 80, tone: 'success' },
  ];

  it('higher_is_better uses goal wording and marks data-direction', () => {
    const tree = layoutChart(
      'ui:meter',
      { value: 60, direction: 'higher_is_better', thresholds },
      env
    ) as { attrs: Record<string, unknown> };
    expect(tree.attrs['data-direction']).toBe('higher_is_better');
    expect(tree.attrs['data-tone']).toBe('warning');
    expect(text(tree)).toContain(en.messages['ui:meter_goal_state_warning']);
  });

  it('default keeps the usage wording', () => {
    const tree = layoutChart('ui:meter', { value: 60, thresholds }, env) as {
      attrs: Record<string, unknown>;
    };
    expect(tree.attrs['data-direction']).toBeUndefined();
    expect(text(tree)).toContain(en.messages['ui:meter_state_warning']);
    expect(() =>
      validateA2UIComponentProps('ui:meter', { value: 1, direction: 'higher_is_better' })
    ).not.toThrow();
  });
});

describe('status glyph families', () => {
  it('every canonical status has a family; the vanilla glyph map mirrors it', () => {
    for (const status of KB_STATUS_VALUES) {
      const family = KB_STATUS_FAMILIES[status];
      expect(family, status).toBeTruthy();
      expect(KB_STATUS_GLYPHS[status], status).toBe(KB_STATUS_FAMILY_GLYPHS[family]);
    }
    expect(Object.keys(KB_STATUS_GLYPHS).sort()).toEqual([...KB_STATUS_VALUES].sort());
  });

  it('running never shares the done glyph, and each family glyph is distinct', () => {
    expect(KB_STATUS_GLYPHS.running).not.toBe(KB_STATUS_GLYPHS.done);
    const glyphs = Object.values(KB_STATUS_FAMILY_GLYPHS);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('the generated CSS gives running the half-filled circle', () => {
    const rules = renderStatusFamilyGlyphRules().join('\n');
    expect(rules).toMatch(/\[data-status="running"\][^}]*--kb-ui-pill-icon: "\\25D0"/);
    expect(rules).toMatch(/\[data-status="done"\][^}]*--kb-ui-pill-icon: "\\2713"/);
  });
});

describe('display-controls language endonyms', () => {
  it('shows each language by its own name regardless of UI locale', () => {
    const endonymJa = localeEndonym('ja', 'fallback');
    expect(endonymJa).not.toBe('fallback');
    expect(localeEndonym('en', 'fallback')).toBe('English');
    for (const locale of ['en', 'ja'] as const) {
      const bundle = getUiMessageBundle(locale);
      const t = createTranslator({ messages: bundle.messages });
      const props = displayLocaleProps(t, {});
      expect(props.options.map((option) => option.label)).toEqual([endonymJa, 'English']);
    }
    const ja = getUiMessageBundle('ja');
    const out = html(
      <KbI18nProvider locale="ja" messages={ja.messages}>
        <DisplayControls locale="en" />
      </KbI18nProvider>
    );
    expect(out).toContain('>English<');
    expect(out).toContain(`>${endonymJa}<`);
  });

  it('falls back to the vocabulary label when Intl.DisplayNames is unavailable', () => {
    const original = Intl.DisplayNames;
    try {
      (Intl as { DisplayNames?: unknown }).DisplayNames = undefined;
      expect(localeEndonym('ja', 'Japanese')).toBe('Japanese');
    } finally {
      (Intl as { DisplayNames?: unknown }).DisplayNames = original;
    }
  });
});

describe('AvatarPicker preview never turns picked file data into an src URL', () => {
  it('draws the picked image on a canvas instead of an object URL', async () => {
    const { pathResolver, safeReadFile } = await import('@agent/core');
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/shared-ui/src/forms/camera.tsx'), {
        encoding: 'utf8',
      })
    );
    const avatar = source.slice(source.indexOf('export function AvatarPicker('));
    expect(avatar).not.toContain('createObjectURL');
    expect(avatar).toContain('<BlobImage');
  });
});
