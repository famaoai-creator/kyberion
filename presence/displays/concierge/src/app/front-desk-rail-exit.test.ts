import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import type { RailSelection } from '../lib/rail-switcher';
import { FrontDeskRail } from './front-desk-rail';

type ActionHandler = (action: string, payload?: Record<string, unknown>) => void;
const captured = vi.hoisted(() => ({
  onAction: null as ActionHandler | null,
  requestLeave: vi.fn<(target: string, navigate: () => void) => void>(),
  context: null as { label: string; detail: string } | null,
}));
vi.mock('../lib/settings-exit-guard', () => ({
  useSettingsExitGuard: () => ({ requestLeave: captured.requestLeave }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../lib/front-desk-fetch', () => ({
  frontDeskFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));
vi.mock('../lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en' }),
}));
vi.mock('../lib/i18n', () => ({ frontDeskText: (key: string) => key }));
vi.mock('@agent/shared-ui', () => ({
  A2UIActionProvider: ({
    onAction,
    children,
  }: {
    onAction: ActionHandler;
    children: ReactNode;
  }) => {
    captured.onAction = onAction;
    return children;
  },
  useA2UIActions: () => ({}),
  NavRail: ({ context, children }: { context: typeof captured.context; children: ReactNode }) => {
    captured.context = context;
    return children;
  },
  Dialog: () => null,
}));

const companies = () => [
  { tenant_slug: 'alpha', display_name: 'Alpha' },
  { tenant_slug: 'beta', display_name: 'Beta' },
];
function viewer(value = 'alpha') {
  const selection: RailSelection =
    value === 'personal' ? { mode: 'personal' } : { mode: 'tenant', tenant_slug: value };
  return {
    ok: true,
    viewing:
      value === 'personal'
        ? null
        : { tenant_slug: value, display_name: value, role: 'owner', status: 'active' },
    tenants: [],
    can_switch: true,
    selection,
    switcher: { personal: true, system: false, companies: companies() },
  };
}
function navigation() {
  return {
    ok: true,
    items: [
      {
        id: 'home',
        label: 'Home',
        href: 'http://studio.test/?organizationId=old&project_id=old',
        external: true,
        allowed: true,
      },
    ],
    role_labels: { owner: 'Owner' },
    tenant_viewing_summary: 'Workspace',
    tenant_viewing_single: 'Workspace',
  };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function locationAt(href: string) {
  const url = new URL(href);
  return Object.assign(url, { assign: vi.fn() });
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
  captured.onAction = null;
  captured.requestLeave.mockReset();
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());

async function mount(selection = 'alpha') {
  const state = { me: viewer(selection), nav: navigation() };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      json(String(input).startsWith('/api/me') ? state.me : state.nav)
    )
  );
  const location = locationAt(
    'http://concierge.test/settings?tenant=' + selection + '&organizationId=org&project_id=proj'
  );
  dom.window.location = location;
  Object.assign(dom.document, { cookie: 'kyberion_selected_tenant=' + selection });
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(createElement(FrontDeskRail)));
  expect(captured.onAction).not.toBeNull();
  const cookie = () => (dom.document as unknown as Document).cookie;
  const action = async (id: string, payload?: Record<string, unknown>) => {
    await act(async () => captured.onAction!(id, payload));
  };
  const refresh = async () => {
    await act(async () => {
      fireEvent(dom.windowEvents, 'popstate');
    });
  };
  const confirm = async () => {
    const latest = captured.requestLeave.mock.calls.at(-1);
    expect(latest).toBeDefined();
    await act(async () => latest![1]());
  };
  return { state, location, cookie, action, refresh, confirm, container };
}

describe('front-desk rail guarded tenant transitions', () => {
  it('does not navigate again when selecting the current context', async () => {
    const m = await mount();
    await m.action('tenant.switch', { value: 'alpha' });
    await m.action('tenant.switch', { value: 'alpha' });
    expect(captured.requestLeave).not.toHaveBeenCalled();
    expect(m.location.assign).not.toHaveBeenCalled();
  });

  it('shows a personal-only context and makes the execution boundary visible', async () => {
    const m = await mount('personal');
    m.state.me.switcher.companies = [];
    await m.refresh();
    expect(captured.context?.label).toBe('tenant_personal_label');
    expect(captured.context?.detail).toBe('tenant_personal_only_detail');
    expect(m.container.querySelector('[data-selection-authority-notice]')?.textContent).toBe(
      'tenant_selection_authority_notice'
    );
  });

  it('pins the request selection instead of depending on a cookie shared with other tabs', async () => {
    await mount('alpha');
    expect(fetch).toHaveBeenCalledWith('/api/me?tenant=alpha', { cache: 'no-store' });
  });

  it('ignores an old response after the URL changes before the next refresh', async () => {
    const m = await mount();
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((settle) => {
          resolve = settle;
        })
    );
    await m.refresh();
    m.location.search = '?tenant=beta';
    const before = m.cookie();
    await act(async () => resolve(json(viewer('alpha'))));
    expect(m.cookie()).toBe(before);
    expect(m.location.search).toBe('?tenant=beta');
    expect(captured.context).toBeUndefined();
  });

  it('revalidates Back and Forward selections and ignores the older response', async () => {
    const m = await mount();
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((settle) => {
          resolve = settle;
        })
    );
    m.location.search = '?tenant=personal';
    await m.refresh();
    m.location.search = '?tenant=beta';
    m.state.me = viewer('beta');
    await m.refresh();
    await act(async () => resolve(json(viewer('personal'))));
    expect(captured.context?.label).toBe('beta');
    expect(m.cookie()).toContain('kyberion_selected_tenant=beta');
  });

  it('does not reflect an interrupted request after unmount', async () => {
    const m = await mount();
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((settle) => {
          resolve = settle;
        })
    );
    await m.refresh();
    const before = m.cookie();
    unmount?.();
    unmount = undefined;
    await act(async () => resolve(json(viewer('beta'))));
    expect(m.cookie()).toBe(before);
  });

  it('does not mutate the tenant cookie or location until the guard permits a switch', async () => {
    const m = await mount();
    const before = m.cookie();
    await m.action('tenant.switch', { value: 'beta' });
    expect(captured.requestLeave).toHaveBeenCalledWith(
      '/settings?tenant=beta',
      expect.any(Function)
    );
    expect(m.cookie()).toBe(before);
    expect(m.location.assign).not.toHaveBeenCalled();
    await m.confirm();
    expect(m.cookie()).toContain('kyberion_selected_tenant=beta;');
    expect(m.location.assign).toHaveBeenCalledExactlyOnceWith('/settings?tenant=beta');
  });

  it('keeps the original tenant when the guard cancels the switch', async () => {
    const m = await mount();
    const before = m.cookie();
    await m.action('tenant.switch', { value: 'beta' });
    // The provider represents Cancel by dropping this continuation.
    captured.requestLeave.mockClear();
    await m.refresh();
    expect(m.cookie()).toBe(before);
    expect(m.location.assign).not.toHaveBeenCalled();
  });

  it('rejects a deferred switch after the selected scope changes', async () => {
    const m = await mount();
    await m.action('tenant.switch', { value: 'beta' });
    m.location.search = '?tenant=personal';
    await m.confirm();
    expect(m.cookie()).toContain('kyberion_selected_tenant=alpha;');
    expect(m.location.assign).not.toHaveBeenCalled();
  });

  it('rechecks the latest switcher grants before changing the cookie', async () => {
    const m = await mount();
    await m.action('tenant.switch', { value: 'beta' });
    m.state.me.switcher.companies = companies().filter((company) => company.tenant_slug !== 'beta');
    await m.refresh();
    const before = m.cookie();
    await m.confirm();
    expect(m.cookie()).toBe(before);
    expect(m.location.assign).not.toHaveBeenCalled();
  });

  it('does not execute a deferred switch while its latest scope is being revalidated', async () => {
    const m = await mount();
    await m.action('tenant.switch', { value: 'beta' });
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((settle) => {
          resolve = settle;
        })
    );
    await m.refresh();
    const before = m.cookie();
    await m.confirm();
    expect(m.cookie()).toBe(before);
    expect(m.location.assign).not.toHaveBeenCalled();
    await act(async () => resolve(json(m.state.me)));
    expect(m.location.assign).not.toHaveBeenCalled();
  });
});

describe('front-desk rail guarded workspace destinations', () => {
  it('defers the selected destination without changing the current workspace', async () => {
    const m = await mount('personal');
    const before = m.cookie();
    await m.action('workspace.open', { id: 'home' });
    await m.action('workspace.choose', { choice: 'tenant:beta' });
    expect(captured.requestLeave).toHaveBeenCalledWith(
      'http://studio.test/?tenant=beta',
      expect.any(Function)
    );
    expect(m.cookie()).toBe(before);
    expect(m.location.assign).not.toHaveBeenCalled();
    await m.confirm();
    expect(m.location.assign).toHaveBeenCalledExactlyOnceWith('http://studio.test/?tenant=beta');
  });

  it('cancels a workspace choice without requesting an exit or changing the cookie', async () => {
    const m = await mount('personal');
    const before = m.cookie();
    await m.action('workspace.open', { id: 'home' });
    await m.action('workspace.choose', { choice: 'cancel' });
    expect(captured.requestLeave).not.toHaveBeenCalled();
    expect(m.cookie()).toBe(before);
    expect(m.location.assign).not.toHaveBeenCalled();
  });

  it.each(['scope', 'company', 'destination'] as const)(
    'rejects a queued workspace destination after the %s becomes stale',
    async (changed) => {
      const m = await mount('personal');
      await m.action('workspace.open', { id: 'home' });
      await m.action('workspace.choose', { choice: 'tenant:beta' });
      if (changed === 'scope') m.location.search = '?tenant=alpha';
      else {
        if (changed === 'company') m.state.me.switcher.companies = [];
        else m.state.nav.items[0].allowed = false;
        await m.refresh();
      }
      const before = m.cookie();
      await m.confirm();
      expect(m.cookie()).toBe(before);
      expect(m.location.assign).not.toHaveBeenCalled();
    }
  );
});

describe('front-desk rail synchronous scope refresh fence', () => {
  it.each(['tenant', 'workspace'] as const)(
    'rejects a queued %s continuation in the same event as a scope refresh',
    async (transition) => {
      const m = await mount(transition === 'tenant' ? 'alpha' : 'personal');
      if (transition === 'tenant') await m.action('tenant.switch', { value: 'beta' });
      else {
        await m.action('workspace.open', { id: 'home' });
        await m.action('workspace.choose', { choice: 'tenant:beta' });
      }
      const pending = captured.requestLeave.mock.calls.at(-1)![1];
      let resolve!: (response: Response) => void;
      vi.mocked(fetch).mockImplementationOnce(
        () =>
          new Promise<Response>((settle) => {
            resolve = settle;
          })
      );
      const before = m.cookie();
      await act(async () => {
        fireEvent(dom.windowEvents, 'popstate');
        // React has not committed latestScope yet. Refresh must synchronously
        // invalidate the authority captured by this queued continuation.
        pending();
      });
      expect(m.cookie()).toBe(before);
      expect(m.location.assign).not.toHaveBeenCalled();
      await act(async () => resolve(json(m.state.me)));
      expect(m.location.assign).not.toHaveBeenCalled();
    }
  );
});
