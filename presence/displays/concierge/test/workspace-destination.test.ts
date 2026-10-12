import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment } from 'react';
import { KbI18nProvider } from '@agent/shared-ui';
import { getUiMessageBundle } from '@agent/core';
import {
  installFakeDom,
  fireEvent,
  type FakeElement,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { CommandPalette } from '../src/app/command-palette';
import { FrontDeskRail } from '../src/app/front-desk-rail';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => null }));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../src/lib/front-desk-fetch', () => ({
  frontDeskFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock('../src/lib/front-desk-auth-token', () => ({
  getStoredFrontDeskToken: () => null,
  isLoopbackHostname: () => true,
}));
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom();
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const navItem = (id: string, href: string) => ({
  id,
  href,
  label: id,
  sublabel: id,
  icon: 'home',
  group_label: 'Work',
  external: href.startsWith('http'),
  allowed: true,
  scope_query_style: 'camel',
  min_role: 'viewer',
});
async function mount(
  mode: 'personal' | 'system' | 'tenant' = 'personal',
  companies = [{ tenant_slug: 'alpha', display_name: 'Alpha workspace' }],
  options: { waitForMe?: Promise<void>; missingProfile?: boolean; failedMe?: boolean } = {}
) {
  const selection = mode === 'tenant' ? { mode, tenant_slug: 'alpha' } : { mode };
  const value = mode === 'system' ? 'shared' : mode === 'tenant' ? 'alpha' : 'personal';
  const location = Object.assign(new URL('http://concierge.test/settings?tenant=' + value), {
    assign: vi.fn(),
  });
  dom.window.location = location;
  dom.window.history = { state: null, replaceState: vi.fn() };
  const me = {
    ok: true,
    selection,
    switcher: { personal: true, system: true, companies },
    viewing:
      mode === 'tenant' && !options.missingProfile
        ? { tenant_slug: 'alpha', display_name: 'Alpha workspace', role: 'owner' }
        : null,
    tenants: [],
    can_switch: true,
  };
  dom.window.dispatchEvent = vi.fn((event: Event) => {
    fireEvent(dom.windowEvents, event.type, { detail: (event as CustomEvent).detail });
    return true;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/me')) {
        await options.waitForMe;
        if (options.failedMe) return new Response('{}', { status: 500 });
      }
      return new Response(
        JSON.stringify(
          url.startsWith('/api/me')
            ? me
            : {
                ok: true,
                items: [navItem('home', 'http://studio.test/'), navItem('settings', '/settings')],
                role_labels: { owner: 'Owner' },
                tenant_viewing_single: '{role}',
                tenant_viewing_summary: '{role}',
              }
        ),
        { status: 200 }
      );
    })
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  const ui = getUiMessageBundle('en');
  act(() =>
    root.render(
      createElement(
        KbI18nProvider,
        { locale: ui.locale, messages: ui.messages },
        createElement(Fragment, null, createElement(FrontDeskRail), createElement(CommandPalette))
      )
    )
  );
  unmount = () => act(() => root.unmount());
  await flush();
  await flush();
  const click = (element: FakeElement) => act(() => fireEvent(element, 'click'));
  const button = (text: string) => {
    const b = container.querySelectorAll('button').find((x) => x.textContent === text);
    if (!b) throw Error('Missing ' + text);
    return b;
  };
  return { container, location, click, button, me };
}
describe('explicit workspace transition dialog', () => {
  it.each(['personal', 'system'] as const)(
    'keeps %s and its history on cancel, then continues only to the selected workspace',
    async (mode) => {
      const m = await mount(mode);
      const opener = m.container.querySelector('[data-nav-id="home"]')!;
      expect(opener.tagName.toLowerCase()).toBe('button');
      opener.focus();
      m.click(opener);
      expect(m.container.textContent).toContain('home works in one workspace');
      expect(m.location.assign).not.toHaveBeenCalled();
      m.click(m.button('Stay here'));
      expect(m.location.assign).not.toHaveBeenCalled();
      expect(
        (dom.window.history as { replaceState: ReturnType<typeof vi.fn> }).replaceState
      ).not.toHaveBeenCalled();
      expect(dom.document.activeElement).toBe(opener);
      m.click(opener);
      m.click(m.button('Open in Alpha workspace'));
      expect(m.location.assign).toHaveBeenCalledExactlyOnceWith('http://studio.test/?tenant=alpha');
    }
  );
  it('retains concrete workspace navigation and permits aggregate-local links', async () => {
    const m = await mount('tenant');
    expect(m.container.querySelector('[data-nav-id="home"]')!.getAttribute('href')).toBe(
      'http://studio.test/?tenant=alpha'
    );
    unmount?.();
    unmount = undefined;
    const aggregate = await mount('personal');
    expect(
      aggregate.container.querySelector('[data-nav-id="settings"]')!.getAttribute('href')
    ).toBe('/settings?tenant=personal');
  });
  it('offers a useful way back when no allowed workspace exists', async () => {
    const m = await mount('personal', []);
    m.click(m.container.querySelector('[data-nav-id="home"]')!);
    expect(m.container.textContent).toContain('none is available for this account');
    m.click(m.button('Stay here'));
    expect(m.location.assign).not.toHaveBeenCalled();
  });
  it('does not use a stale workspace choice after the source scope changes', async () => {
    const m = await mount();
    m.click(m.container.querySelector('[data-nav-id="home"]')!);
    m.location.search = '?tenant=beta';
    m.click(m.button('Open in Alpha workspace'));
    expect(m.location.assign).not.toHaveBeenCalled();
  });
  it('supports Escape and restores focus without navigating', async () => {
    const m = await mount();
    const opener = m.container.querySelector('[data-nav-id="home"]')!;
    opener.focus();
    m.click(opener);
    act(() =>
      fireEvent(m.container.querySelector('[role="dialog"]')!, 'keydown', { key: 'Escape' })
    );
    expect(m.location.assign).not.toHaveBeenCalled();
    expect(dom.document.activeElement).toBe(opener);
  });
});

it('keeps a palette destination while the shared rail is waiting for its authorized workspace list', async () => {
  let release!: () => void;
  const waitForMe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const m = await mount('personal', undefined, { waitForMe });
  act(() => fireEvent(dom.windowEvents, 'keydown', { key: 'k', ctrlKey: true }));
  await flush();
  m.click(m.container.querySelector('[id="palette-item-front-desk-home"]')!);
  expect(m.container.textContent).toContain('Checking available workspaces');
  expect(m.location.assign).not.toHaveBeenCalled();
  await act(async () => release());
  await flush();
  await flush();
  expect(m.container.textContent).toContain('home works in one workspace');
  m.click(m.button('Open in Alpha workspace'));
  expect(m.location.assign).toHaveBeenCalledExactlyOnceWith('http://studio.test/?tenant=alpha');
});
it('uses canonical concrete selection even when its display profile is absent', async () => {
  const m = await mount('tenant', undefined, { missingProfile: true });
  expect(m.container.querySelector('[data-nav-id="home"]')!.getAttribute('href')).toBe(
    'http://studio.test/?tenant=alpha'
  );
});

it('ends a queued chooser loading state when the workspace read fails', async () => {
  let release!: () => void;
  const waitForMe = new Promise<void>((resolve) => {
    release = resolve;
  });
  const m = await mount('personal', undefined, { waitForMe, failedMe: true });
  act(() => fireEvent(dom.windowEvents, 'keydown', { key: 'k', ctrlKey: true }));
  await flush();
  m.click(m.container.querySelector('[id="palette-item-front-desk-home"]')!);
  await act(async () => release());
  await flush();
  expect(m.container.textContent).toContain('no longer available');
  expect(m.container.textContent).not.toContain('Checking available workspaces');
  m.click(m.button('Stay here'));
  expect(m.location.assign).not.toHaveBeenCalled();
});
