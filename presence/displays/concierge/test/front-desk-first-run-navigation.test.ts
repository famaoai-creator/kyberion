import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { installFakeDom } from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { FrontDeskRail } from '../src/app/front-desk-rail';

const route = vi.hoisted(() => ({ pathname: '/setup/first-run' }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
vi.mock('../src/lib/i18n', () => ({ frontDeskText: (key: string) => key }));

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

async function mount(path: string) {
  const url = new URL(path, 'https://concierge.example.test');
  route.pathname = url.pathname;
  const assign = vi.fn();
  dom.window.location = {
    href: url.href,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    origin: url.origin,
    assign,
  };
  const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
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
  return { container, fetcher, assign };
}

describe('remote first-run rail navigation', () => {
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
