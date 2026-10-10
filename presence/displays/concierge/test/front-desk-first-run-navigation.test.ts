import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { installFakeDom } from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { FrontDeskRail } from '../src/app/front-desk-rail';

const route = vi.hoisted(() => ({
  pathname: '/setup/first-run',
  search: '',
  listeners: new Set<() => void>(),
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    usePathname: () => route.pathname,
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(
          (listener) => {
            route.listeners.add(listener);
            return () => {
              route.listeners.delete(listener);
            };
          },
          () => route.search,
          () => ''
        )
      ),
  };
});
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../src/lib/i18n', () => ({ frontDeskText: (key: string) => key }));

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
});
afterAll(() => dom.restore());

async function mount(
  path: string,
  fetcher = vi.fn(async (_input: unknown) => new Response(null, { status: 401 }))
) {
  const url = new URL(path, 'https://concierge.example.test');
  route.pathname = url.pathname;
  route.search = url.search;
  const assign = vi.fn();
  dom.window.location = {
    href: url.href,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    origin: url.origin,
    assign,
  };
  vi.stubGlobal('fetch', fetcher);
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => {
    act(() => root.unmount());
    dom.document.body.removeChild(container);
  };
  await act(async () => {
    root.render(createElement(FrontDeskRail));
  });
  const changeQuery = async (query: string) => {
    const next = new URL(url.pathname + query, url.origin);
    dom.window.location = {
      href: next.href,
      hostname: next.hostname,
      pathname: next.pathname,
      search: next.search,
      origin: next.origin,
      assign,
    };
    await act(async () => {
      route.search = next.search;
      for (const listener of route.listeners) listener();
    });
  };
  return { container, fetcher, assign, changeQuery };
}

describe('remote first-run rail navigation', () => {
  it('refreshes scoped hrefs on query-only management selection changes', async () => {
    const tenant = { tenant_slug: 'alpha', display_name: 'Alpha', role: 'owner', status: 'active' };
    const fetcher = vi.fn(async (input: unknown) =>
      Response.json(
        String(input).startsWith('/api/me')
          ? { ok: true, viewing: tenant, tenants: [tenant], can_switch: false }
          : {
              ok: true,
              items: [
                {
                  id: 'organization',
                  label: 'Management',
                  href: '/management',
                  allowed: true,
                  scope_query_style: 'camel',
                  icon: 'user',
                  group_label: 'Manage',
                },
                {
                  id: 'missions',
                  label: 'Missions',
                  href: 'https://chronos.example.test/?section=missions',
                  allowed: true,
                  scope_query_style: 'snake',
                  icon: 'mission',
                  group_label: 'Work',
                },
              ],
              role_labels: { owner: 'Owner' },
              tenant_viewing_single: '{role}',
              aria_label: 'Navigation',
            }
      )
    );
    const { container, changeQuery } = await mount(
      '/management?tenant=alpha&organization_id=org-a&project_id=prj-a',
      fetcher
    );
    const href = (label: string) =>
      container
        .querySelectorAll('a')
        .find((link) => link.textContent.includes(label))
        ?.getAttribute('href');
    expect(href('Missions')).toContain('organization_id=org-a');
    expect(href('Missions')).toContain('project_id=prj-a');
    await changeQuery('?tenant=alpha&organization_id=org-b&project_id=prj-b');
    expect(href('Missions')).toContain('organization_id=org-b');
    expect(href('Missions')).toContain('project_id=prj-b');
    expect(href('Management')).toContain('organizationId=org-b');
    expect(href('Management')).toContain('projectId=prj-b');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps unauthenticated first-run onboarding reachable with no active navigation', async () => {
    const { container, fetcher, assign } = await mount('/setup/first-run');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/me', expect.anything());
    expect(assign).not.toHaveBeenCalled();
    expect(container.querySelector('nav')).not.toBeNull();
    expect(container.textContent).toContain('Kyberion');
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  });

  it('still redirects unauthenticated setup pages to login with the full next path', async () => {
    const { fetcher, assign } = await mount('/setup/sso?provider=oidc&returnTo=%2Fsettings');

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/api/me', expect.anything());
    expect(assign).toHaveBeenCalledExactlyOnceWith(
      '/login?next=' + encodeURIComponent('/setup/sso?provider=oidc&returnTo=%2Fsettings')
    );
  });
});
