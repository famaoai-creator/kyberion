import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { CommandPalette } from '../src/app/command-palette';

const i18n = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: i18n.locale, t: (key: string) => key }),
}));
vi.mock('../src/lib/front-desk-auth-token', () => ({
  attachFrontDeskAuthHeaders: () => ({ Authorization: 'Bearer test-session' }),
}));
vi.mock('../src/lib/i18n', () => ({
  frontDeskText: (key: string) => key,
}));

const json = (items: unknown[], status = 200) =>
  new Response(JSON.stringify({ items }), { status });
const item = (id: string, allowed: unknown = true, href = '/' + id) => ({
  id,
  label: id,
  sublabel: 'Find ' + id,
  group_label: 'Workspace',
  icon: 'page',
  href,
  allowed,
});
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function locationAt(href: string) {
  let url = new URL(href);
  return {
    get href() {
      return url.href;
    },
    set href(value: string) {
      url = new URL(value, url);
    },
    get search() {
      return url.search;
    },
    get hash() {
      return url.hash;
    },
    get pathname() {
      return url.pathname;
    },
    get origin() {
      return url.origin;
    },
  };
}
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
  i18n.locale = 'en';
});
afterAll(() => dom.restore());

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function mount(load: () => Promise<Response>) {
  const fetcher = vi.fn(load);
  vi.stubGlobal('fetch', fetcher);
  dom.window.location = locationAt('http://concierge.test/settings?tenant=alpha');
  dom.window.dispatchEvent = vi.fn((event: Event) => {
    fireEvent(dom.windowEvents, event.type);
    return true;
  });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const opener = dom.document.createElement('button');
  dom.document.body.appendChild(opener);
  opener.focus();
  const root = client.createRoot(container as unknown as Element);
  const render = () => act(() => root.render(createElement(CommandPalette)));
  render();
  unmount = () => act(() => root.unmount());
  const toggle = () =>
    act(() => {
      fireEvent(dom.windowEvents, 'keydown', { key: 'k', ctrlKey: true });
    });
  const key = (key: string) =>
    act(() => {
      fireEvent(container.querySelector('input')!, 'keydown', { key });
    });
  const click = (id: string) =>
    act(() => {
      fireEvent(container.querySelector('[id="palette-item-' + id + '"]')!, 'click');
    });
  const switchTenant = (tenant: string) =>
    act(() => {
      dom.window.location = locationAt('http://concierge.test/settings?tenant=' + tenant);
      fireEvent(dom.windowEvents, 'front-desk:tenant-changed');
    });
  return { container, fetcher, opener, toggle, key, click, switchTenant, render };
}

describe('server-gated command palette', () => {
  it('fetches on open with session headers and selected scope, exposing only explicit allowed entries', async () => {
    const m = mount(async () =>
      json([
        item('home'),
        item('settings', false),
        item('ingest', false),
        item('maybe', 'true'),
        item('work-items', true, 'http://studio.test/work-items'),
      ])
    );
    expect(m.fetcher).not.toHaveBeenCalled();
    m.toggle();
    await flush();
    expect(m.fetcher).toHaveBeenCalledWith(
      '/api/front-desk/nav?locale=en&tenant=alpha',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-session' },
        cache: 'no-store',
      })
    );
    const text = m.container.textContent;
    expect(text).toContain('work-items');
    expect(text).toContain('palette.dock');
    expect(text).not.toContain('settings_nav');
    expect(text).not.toContain('ingest');
    expect(text).not.toContain('maybe');
    m.click('front-desk-work-items');
    expect((dom.window.location as URL).href).toBe('http://studio.test/work-items?tenant=alpha');
  });

  it('offers all nine real settings anchors only with the catalog settings grant', async () => {
    const m = mount(async () => json([item('settings')]));
    m.toggle();
    await flush();
    for (const anchor of [
      'setup-profile',
      'settings-display',
      'settings-members',
      'setup-services',
      'setup-media',
      'setup-notifications',
      'settings-recording',
      'setup-plugins',
      'settings-advanced',
    ]) {
      expect(m.container.querySelector('[id="palette-item-' + anchor + '"]')).not.toBeNull();
    }
    m.click('settings-advanced');
    expect((dom.window.location as URL).href).toBe(
      'http://concierge.test/settings?tenant=alpha#settings-advanced'
    );
    expect(dom.document.activeElement).toBe(m.opener);
  });

  it('invalidates tenant grants immediately and ignores late responses for the old tenant', async () => {
    const first = deferred();
    const second = deferred();
    let count = 0;
    const m = mount(() => (++count === 1 ? first.promise : second.promise));
    m.toggle();
    m.switchTenant('beta');
    await act(async () => second.resolve(json([item('home')])));
    await act(async () => first.resolve(json([item('settings')])));
    await flush();
    expect(m.container.textContent).toContain('home');
    expect(m.container.textContent).not.toContain('settings');
    expect(m.fetcher).toHaveBeenLastCalledWith(
      '/api/front-desk/nav?locale=en&tenant=beta',
      expect.anything()
    );
  });

  it('does not revive a closed session and refetches on reopen, preserving Escape and focus', async () => {
    const first = deferred();
    let count = 0;
    const m = mount(() => (++count === 1 ? first.promise : Promise.resolve(json([item('home')]))));
    m.toggle();
    m.key('Escape');
    expect(dom.document.activeElement).toBe(m.opener);
    m.toggle();
    await flush();
    await act(async () => first.resolve(json([item('settings')])));
    expect(m.container.textContent).not.toContain('settings');
    expect(m.container.textContent).toContain('home');
    m.key('ArrowDown');
    m.key('Enter');
    expect((dom.window.location as URL).pathname).toBe('/home');
  });

  it('drops old localized entries and fetches for the current locale', async () => {
    const later = deferred();
    let count = 0;
    const m = mount(() =>
      ++count === 1 ? Promise.resolve(json([item('settings')])) : later.promise
    );
    m.toggle();
    await flush();
    i18n.locale = 'ja';
    m.render();
    expect(m.container.textContent).not.toContain('settings_nav');
    await act(async () => later.resolve(json([item('localized-home')])));
    expect(m.fetcher).toHaveBeenLastCalledWith(
      '/api/front-desk/nav?locale=ja&tenant=alpha',
      expect.anything()
    );
    expect(m.container.textContent).toContain('localized-home');
  });

  it('removes a loaded owner catalog before a downgraded tenant request resolves', async () => {
    const next = deferred();
    let count = 0;
    const m = mount(() =>
      ++count === 1 ? Promise.resolve(json([item('settings')])) : next.promise
    );
    m.toggle();
    await flush();
    expect(m.container.textContent).toContain('settings_nav_advanced');
    m.switchTenant('beta');
    expect(m.container.textContent).not.toContain('settings');
    await act(async () => next.resolve(json([item('home'), item('settings', false)])));
    expect(m.container.textContent).not.toContain('settings');
  });

  it('re-announces an unchanged hash so a collapsed settings section can reopen', async () => {
    const m = mount(async () => json([item('settings')]));
    dom.window.location = locationAt(
      'http://concierge.test/settings?tenant=alpha#settings-advanced'
    );
    m.toggle();
    await flush();
    m.click('settings-advanced');
    expect(dom.window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hashchange' })
    );
  });

  it('maps organization and project context to the destination scope query style', async () => {
    const m = mount(async () =>
      json([
        {
          ...item('missions', true, 'http://localhost:3000/?section=missions'),
          scope_query_style: 'snake',
        },
      ])
    );
    dom.window.location = locationAt(
      'http://concierge.test/settings?tenant=alpha&organizationId=org&projectId=proj'
    );
    m.toggle();
    await flush();
    m.click('front-desk-missions');
    const destination = new URL((dom.window.location as URL).href);
    expect(destination.origin).toBe('http://localhost:3000');
    expect(destination.searchParams.get('section')).toBe('missions');
    expect(destination.searchParams.get('tenant')).toBe('alpha');
    expect(destination.searchParams.get('organization_id')).toBe('org');
    expect(destination.searchParams.get('project_id')).toBe('proj');
    expect(destination.searchParams.has('organizationId')).toBe(false);
    expect(destination.searchParams.has('projectId')).toBe(false);
  });

  it('refreshes tenant grants on Back and Forward popstate without reviving stale grants', async () => {
    const back = deferred();
    const forward = deferred();
    let count = 0;
    const m = mount(() => {
      count += 1;
      if (count === 1) return Promise.resolve(json([item('settings')]));
      return count === 2 ? back.promise : forward.promise;
    });
    m.toggle();
    await flush();
    expect(m.container.textContent).toContain('settings_nav_advanced');
    const historyTenant = (tenant: string) =>
      act(() => {
        dom.window.location = locationAt('http://concierge.test/settings?tenant=' + tenant);
        fireEvent(dom.windowEvents, 'popstate');
      });
    historyTenant('beta');
    expect(m.container.textContent).not.toContain('settings');
    expect(m.fetcher).toHaveBeenLastCalledWith(
      '/api/front-desk/nav?locale=en&tenant=beta',
      expect.anything()
    );
    historyTenant('alpha');
    expect(m.fetcher).toHaveBeenLastCalledWith(
      '/api/front-desk/nav?locale=en&tenant=alpha',
      expect.anything()
    );
    await act(async () => forward.resolve(json([item('home')])));
    await act(async () => back.resolve(json([item('settings')])));
    expect(m.container.textContent).toContain('home');
    expect(m.container.textContent).not.toContain('settings');
    expect(m.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['http', 'network', 'malformed'])(
    'fails closed on %s failure while keeping the dock',
    async (kind) => {
      const m = mount(async () => {
        if (kind === 'network') throw new Error('Offline');
        if (kind === 'malformed') return new Response('not-json');
        return json([item('settings')], 403);
      });
      m.toggle();
      await flush();
      expect(m.container.querySelectorAll('button')).toHaveLength(1);
      expect(m.container.textContent).toContain('palette.dock');
      m.key('Enter');
      expect(dom.window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'concierge:open-dock' })
      );
    }
  );
});
