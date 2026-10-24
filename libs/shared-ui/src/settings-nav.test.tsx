import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateA2UIComponentProps } from '../../core/surface/a2ui-catalog.js';
import { renderA2UI } from '../vanilla/kyberion-ui.js';
import { MiniDocument } from '../vanilla/mini-dom.test-support.js';
import { fireEvent, installFakeDom } from '../vanilla/fake-dom.test-support.js';
import { A2UIActionProvider, SettingsNav, type SettingsNavProps } from './index.js';

const props: SettingsNavProps = {
  label: 'Settings sections',
  active: 'profile',
  groups: [
    {
      id: 'personal',
      label: 'Personal',
      items: [
        {
          id: 'profile',
          label: 'Profile',
          description: 'Your name',
          icon: 'user',
          href: '#profile',
          badge: '2',
          status: 'needs_setup',
          action: { id: 'settings.open', payload: { section: 'profile' } },
        },
      ],
    },
  ],
};

describe('settings navigation contract', () => {
  it('accepts named groups and rejects incomplete or executable navigation', () => {
    expect(() => validateA2UIComponentProps('ui:settings-nav', props)).not.toThrow();
    for (const invalid of [
      { ...props, groups: [] },
      { ...props, label: '' },
      { ...props, groups: [{ id: 'g', items: [{ id: 'p', label: 'P' }] }] },
      {
        ...props,
        groups: [{ id: 'g', items: [{ id: 'p', label: 'P', href: 'javascript:alert(1)' }] }],
      },
      {
        ...props,
        groups: [{ id: 'g', items: [{ id: 'p', label: 'P', href: '#p', status: 'made-up' }] }],
      },
      { ...props, onNavigate: () => {} },
    ])
      expect(() => validateA2UIComponentProps('ui:settings-nav', invalid)).toThrow();
  });

  it('announces a named navigation landmark and current location without tab semantics', () => {
    const html = renderToStaticMarkup(<SettingsNav {...props} />);
    expect(html).toContain('<nav class="kb-settings-nav" aria-label="Settings sections">');
    expect(html).toContain('href="#profile"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('Your name');
    expect(html).toContain('needs_setup');
    expect(html).not.toContain('role="tab');
    expect(html).not.toContain('tabindex=');
  });

  it('drops unsafe hrefs and their actions in both renderers', () => {
    const unsafe = {
      ...props,
      groups: [{ id: 'g', items: [{ ...props.groups[0].items[0], href: 'data:text/html,boom' }] }],
    };
    const html = renderToStaticMarkup(<SettingsNav {...unsafe} />);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('data-action-id');
    const document = new MiniDocument();
    const root = document.createElement('div');
    const action = vi.fn();
    renderA2UI(
      root as unknown as Element,
      [{ id: 'nav', type: 'ui:settings-nav', props: unsafe }],
      { document: document as unknown as Document, onAction: action }
    );
    const item = root.query('.kb-settings-nav__link')!;
    expect(item.getAttribute('href')).toBeNull();
    expect(item.getAttribute('aria-disabled')).toBe('true');
    item.click();
    expect(action).not.toHaveBeenCalled();
  });

  it('dispatches vanilla actions once for plain activation, preserving modified clicks', () => {
    const document = new MiniDocument();
    const root = document.createElement('div');
    const action = vi.fn();
    renderA2UI(root as unknown as Element, [{ id: 'nav', type: 'ui:settings-nav', props }], {
      document: document as unknown as Document,
      onAction: action,
    });
    const item = root.query('a')!;
    const preventDefault = vi.fn();
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ])
      item.dispatch('click', { button: 0, preventDefault, ...extra });
    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    item.dispatch('click', { button: 0, preventDefault });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][0]).toEqual({
      id: 'settings.open',
      payload: { section: 'profile' },
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterAll(() => dom.restore());

describe('React settings navigation interaction', () => {
  function mount(onNavigate?: SettingsNavProps['onNavigate'], withActions = true) {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = client.createRoot(container as unknown as Element);
    const action = vi.fn();
    act(() =>
      root.render(
        <A2UIActionProvider onAction={withActions ? action : undefined}>
          <SettingsNav {...props} onNavigate={onNavigate} />
        </A2UIActionProvider>
      )
    );
    return {
      link: container.querySelector('a')!,
      action,
      unmount: () => act(() => root.unmount()),
    };
  }

  it('uses the host scroll manager only for plain clicks and preserves the real href', () => {
    const onNavigate = vi.fn();
    const ui = mount(onNavigate);
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = fireEvent(ui.link, 'click', { button: 0, ...extra });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onNavigate).not.toHaveBeenCalled();
    const event = fireEvent(ui.link, 'click', { button: 0 });
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('#profile', 'profile');
    expect(ui.action).not.toHaveBeenCalled();
    expect(ui.link.getAttribute('href')).toBe('#profile');
    ui.unmount();
  });

  it('dispatches an action when supplied and leaves native navigation available without a handler', () => {
    const ui = mount();
    fireEvent(ui.link, 'click', { button: 0 });
    expect(ui.action).toHaveBeenCalledExactlyOnceWith('settings.open', { section: 'profile' });
    ui.unmount();
    const native = mount(undefined, false);
    const event = fireEvent(native.link, 'click', { button: 0 });
    expect(event.defaultPrevented).toBe(false);
    native.unmount();
  });
});
