import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { CommandPalette } from '../src/app/command-palette';

const i18n = vi.hoisted(() => ({ locale: 'en' }));
const exit = vi.hoisted(() => ({
  requestLeave: vi.fn((_target: string, navigate: () => void) => navigate()),
}));
vi.mock('../src/lib/settings-exit-guard', () => ({
  useSettingsExitGuard: () => ({ requestLeave: exit.requestLeave }),
}));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: i18n.locale, t: (key: string) => key }),
}));
vi.mock('../src/lib/front-desk-auth-token', () => ({
  attachFrontDeskAuthHeaders: () => ({ Authorization: 'Bearer test-session' }),
  getStoredFrontDeskToken: () => 'test-session',
  readFrontDeskRequestToken: () => 'test-session',
  getFrontDeskAuthRevision: () => 0,
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
  dom = installFakeDom({ sessionStorage: { getItem: () => null } });
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
  i18n.locale = 'en';
  exit.requestLeave.mockReset().mockImplementation((_target, navigate) => navigate());
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
        headers: expect.any(Headers),
        cache: 'no-store',
      })
    );
    const [, init] = m.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-session');
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

it.each(['personal', 'shared'])(
  'retains the intended external destination for explicit %s workspace selection',
  async (scope) => {
    const m = mount(async () => json([item('home', true, 'http://studio.test/')]));
    m.switchTenant(scope);
    const before = (dom.window.location as URL).href;
    m.toggle();
    await flush();
    m.click('front-desk-home');
    expect((dom.window.location as URL).href).toBe(before);
    expect(dom.window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'front-desk:workspace-destination',
        detail: { id: 'home' },
      })
    );
    expect(dom.document.activeElement).toBe(m.opener);
  }
);

describe('command palette controlled exits', () => {
  it.each(['/ingest', 'http://studio.test/work-items'])(
    'waits for confirmation before assigning %s',
    async (href) => {
      let proceed: (() => void) | undefined;
      exit.requestLeave.mockImplementation((_target, navigate) => {
        proceed = navigate;
      });
      const m = mount(async () => json([item('destination', true, href)]));
      const before = (dom.window.location as URL).href;
      m.toggle();
      await flush();
      m.click('front-desk-destination');
      const target = href + '?tenant=alpha';
      expect(exit.requestLeave).toHaveBeenCalledWith(target, expect.any(Function));
      expect((dom.window.location as URL).href).toBe(before);
      expect(m.container.querySelector('[role="dialog"]')).toBeNull();
      expect(dom.document.activeElement).toBe(m.opener);
      act(() => proceed!());
      expect((dom.window.location as URL).href).toBe(new URL(target, before).href);
    }
  );

  it('cancelling a queued exit leaves the current page and scope unchanged', async () => {
    exit.requestLeave.mockImplementation(() => {});
    const m = mount(async () => json([item('ingest')]));
    const before = (dom.window.location as URL).href;
    m.toggle();
    await flush();
    m.click('front-desk-ingest');
    expect(exit.requestLeave).toHaveBeenCalledTimes(1);
    expect((dom.window.location as URL).href).toBe(before);
    m.toggle();
    await flush();
    expect(m.container.textContent).toContain('ingest');
    m.key('Escape');
    expect((dom.window.location as URL).href).toBe(before);
  });

  it('rechecks the selected tenant when a deferred confirmation is accepted', async () => {
    let proceed: (() => void) | undefined;
    exit.requestLeave.mockImplementation((_target, navigate) => {
      proceed = navigate;
    });
    const m = mount(async () => json([item('ingest')]));
    m.toggle();
    await flush();
    m.click('front-desk-ingest');
    m.switchTenant('beta');
    const changed = (dom.window.location as URL).href;
    act(() => proceed!());
    expect((dom.window.location as URL).href).toBe(changed);
  });

  it('rejects a stale catalog selection before it reaches the exit guard', async () => {
    const m = mount(async () => json([item('ingest')]));
    m.toggle();
    await flush();
    dom.window.location = locationAt('http://concierge.test/settings?tenant=beta');
    m.click('front-desk-ingest');
    expect(exit.requestLeave).not.toHaveBeenCalled();
    expect((dom.window.location as URL).pathname).toBe('/settings');
  });

  it('reopens an unchanged settings anchor without queuing a page exit', async () => {
    exit.requestLeave.mockImplementation(() => {});
    const m = mount(async () => json([item('settings')]));
    dom.window.location = locationAt(
      'http://concierge.test/settings?tenant=alpha#settings-advanced'
    );
    m.toggle();
    await flush();
    m.click('settings-advanced');
    expect(exit.requestLeave).not.toHaveBeenCalled();
    expect(dom.window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'hashchange' })
    );
  });

  it('opens the dock without queuing a page exit', async () => {
    exit.requestLeave.mockImplementation(() => {});
    const m = mount(async () => json([]));
    m.toggle();
    await flush();
    m.key('Enter');
    expect(exit.requestLeave).not.toHaveBeenCalled();
    expect(dom.window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'concierge:open-dock' })
    );
  });
});

describe('command palette exact workspace scope fence', () => {
  it.each(['personal', 'shared'] as const)(
    'rejects a queued same-origin exit after changing from %s to the other aggregate scope',
    async (selection) => {
      let proceed: (() => void) | undefined;
      exit.requestLeave.mockImplementation((_target, navigate) => {
        proceed = navigate;
      });
      const m = mount(async () => json([item('ingest')]));
      m.switchTenant(selection);
      m.toggle();
      await flush();
      m.click('front-desk-ingest');
      expect(exit.requestLeave).toHaveBeenCalledWith(
        '/ingest?tenant=' + selection,
        expect.any(Function)
      );
      m.switchTenant(selection === 'personal' ? 'shared' : 'personal');
      const changed = (dom.window.location as URL).href;
      act(() => proceed!());
      expect((dom.window.location as URL).href).toBe(changed);
    }
  );
});
