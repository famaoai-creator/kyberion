import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getUiMessageBundle } from '@agent/core';
import {
  KB_STATUS_VALUES,
  KB_STATUS_TONES,
  KYBERION_BASE_ALIASES,
  KYBERION_BASE_COMPONENT_TYPES,
  resolveKyberionBaseType,
} from '@agent/core/a2ui-catalog';
import {
  A2UIRenderer,
  KB_ALIASES,
  KB_COMPONENT_TYPES,
  KB_STATUS_MESSAGE_KEYS,
  KB_STATUS_TONE_MAP,
  resolveKbType,
  type A2UIRendererComponent,
} from './index.js';

const render = (props: Parameters<typeof A2UIRenderer>[0]) =>
  renderToStaticMarkup(<A2UIRenderer {...props} />);

describe('client-safe catalog mirror stays in lock-step with @agent/core/a2ui-catalog', () => {
  it('mirrors component types, aliases, status tones and labels every status', () => {
    expect([...KB_COMPONENT_TYPES]).toEqual([...KYBERION_BASE_COMPONENT_TYPES]);
    expect({ ...KB_ALIASES }).toEqual({ ...KYBERION_BASE_ALIASES });
    expect({ ...KB_STATUS_TONE_MAP }).toEqual({ ...KB_STATUS_TONES });
    expect(Object.keys(KB_STATUS_MESSAGE_KEYS).sort()).toEqual([...KB_STATUS_VALUES].sort());
    for (const type of ['ui:table', 'text', 'card', 'display:table', 'nope']) {
      expect(resolveKbType(type)).toBe(resolveKyberionBaseType(type));
    }
  });
});

describe('A2UIRenderer', () => {
  it('renders roots in list order and children in `children` order', () => {
    const components: A2UIRendererComponent[] = [
      { id: 'root', type: 'ui:stack', props: { gap: 'sm' }, children: ['c', 'a', 'b'] },
      { id: 'a', type: 'ui:text', props: { text: 'A' } },
      { id: 'b', type: 'ui:text', props: { text: 'B' } },
      { id: 'c', type: 'ui:text', props: { text: 'C' } },
      { id: 'second-root', type: 'ui:badge', props: { label: 'R2' } },
    ];
    expect(render({ components })).toBe(
      '<div class="kb-stack" data-gap="sm"><p class="kb-text kb-text--body">C</p><p class="kb-text kb-text--body">A</p><p class="kb-text kb-text--body">B</p></div><span class="kb-badge">R2</span>'
    );
  });

  it('honours rootId and renders nothing for an unknown root', () => {
    const components: A2UIRendererComponent[] = [
      { id: 'root', type: 'ui:stack', props: {}, children: ['leaf'] },
      { id: 'leaf', type: 'ui:text', props: { text: 'leaf' } },
    ];
    expect(render({ components, rootId: 'leaf' })).toBe(
      '<p class="kb-text kb-text--body">leaf</p>'
    );
    expect(render({ components, rootId: 'missing' })).toBe('');
  });

  it('resolves legacy aliases onto catalog components', () => {
    const components: A2UIRendererComponent[] = [
      { id: 'card', type: 'card', props: { title: 'カード' }, children: ['box'] },
      { id: 'box', type: 'container', props: { direction: 'row' }, children: ['t', 'btn'] },
      { id: 't', type: 'text', props: { value: 'こんにちは' } },
      { id: 'btn', type: 'button', props: { text: '押す', action: 'press' } },
    ];
    expect(render({ components })).toBe(
      '<section class="kb-section"><header class="kb-section__header"><div class="kb-section__heading"><h2 class="kb-section__title">カード</h2></div></header>' +
        '<div class="kb-stack" data-direction="horizontal"><p class="kb-text kb-text--body">こんにちは</p>' +
        '<button type="button" class="kb-btn kb-btn--secondary" data-action-id="press">押す</button></div></section>'
    );
  });

  it('splits app-shell children into the nav slot and main slot', () => {
    const out = render({
      components: [
        {
          id: 'shell',
          type: 'ui:app-shell',
          props: { density: 'compact' },
          children: ['header', 'nav'],
        },
        {
          id: 'nav',
          type: 'ui:nav-rail',
          props: { items: [{ id: 'h', label: 'ホーム', href: '/' }] },
        },
        { id: 'header', type: 'ui:page-header', props: { title: '監査モニタ' } },
      ],
    });
    expect(out).toMatch(
      /^<div class="kb-app-shell" data-density="compact"><div class="kb-app-shell__nav"><nav class="kb-nav-rail"[^>]*>.*<\/nav><\/div><main class="kb-app-shell__main"><header class="kb-page-header">/
    );
  });

  it('drops unsafe hrefs coming through A2UI props', () => {
    const out = render({
      components: [
        { id: 'b', type: 'ui:button', props: { label: 'x', href: 'javascript:alert(1)' } },
        { id: 'l', type: 'ui:list', props: { items: [{ title: 't', href: 'data:text/html,1' }] } },
      ],
    });
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text');
  });

  it('uses the fallback registry for non-catalog types; catalog types always win', () => {
    const out = render({
      components: [
        { id: 'root', type: 'ui:stack', props: {}, children: ['legacy'] },
        { id: 'legacy', type: 'display:hero', props: { title: 'Hero' }, children: ['inner'] },
        { id: 'inner', type: 'ui:badge', props: { label: 'in' } },
      ],
      fallback: {
        'display:hero': ({ id, props, children }) => (
          <div data-fallback={id}>
            {String(props.title)}
            {children}
          </div>
        ),
        'ui:stack': () => <b>never</b>,
      },
    });
    expect(out).toBe(
      '<div class="kb-stack"><div data-fallback="legacy">Hero<span class="kb-badge">in</span></div></div>'
    );
  });

  it('shows a warning callout for unknown types only when enabled', () => {
    const components: A2UIRendererComponent[] = [{ id: 'x', type: 'kb-mystery', props: {} }];
    const dev = render({ components, showUnknown: true });
    expect(dev).toContain(
      '<div class="kb-callout" data-tone="warning" role="note" data-unknown-type="kb-mystery">'
    );
    expect(dev).toContain('<p class="kb-callout__title">Unsupported component: kb-mystery</p>');
    const ja = getUiMessageBundle('ja');
    expect(
      render({ components, showUnknown: true, locale: ja.locale, messages: ja.messages })
    ).toContain('<p class="kb-callout__title">未対応のコンポーネント: kb-mystery</p>');
    expect(render({ components, showUnknown: false })).toBe('');
  });

  it('survives cycles, missing children and malformed entries', () => {
    const out = render({
      components: [
        { id: 'a', type: 'ui:stack', props: {}, children: ['b', 'ghost'] },
        { id: 'b', type: 'ui:stack', props: {}, children: ['a'] },
        null as unknown as A2UIRendererComponent,
        { id: 'c', type: 'ui:text', props: 'bad' as unknown as Record<string, unknown> },
      ],
      rootId: 'a',
    });
    expect(out).toBe('<div class="kb-stack"><div class="kb-stack"></div></div>');
  });
});
