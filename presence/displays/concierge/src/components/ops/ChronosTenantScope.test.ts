import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { ChronosTenantScope } from './ChronosTenantScope';

const navigation = vi.hoisted(() => ({ search: 'tenant=acme&organization_id=sales' }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push }),
  usePathname: () => '/',
}));
vi.mock('../../lib/ops/hooks', () => ({ useChronosLocale: () => 'en' }));

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
  navigation.search = 'tenant=acme&organization_id=sales';
  push.mockReset();
});
afterAll(() => dom.restore());

it('withdraws stale selector options and announces a failed scope reload', async () => {
  let fail = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      fail
        ? new Response('{}', { status: 403 })
        : new Response(
            JSON.stringify({
              ok: true,
              tenants: ['acme'],
              organizations: [{ id: 'sales', tenant_slug: 'acme' }],
              projects: [{ id: 'old-project', organization_id: 'sales' }],
            })
          )
    )
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(createElement(ChronosTenantScope)));
  expect(container.textContent).toContain('old-project');
  fail = true;
  navigation.search = 'tenant=other&organization_id=deleted&operation_id=gone&candidateKey=stale';
  await act(async () => root.render(createElement(ChronosTenantScope)));
  expect(container.textContent).not.toContain('old-project');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(
    [...container.querySelectorAll('select')].every((select) => select.hasAttribute('disabled'))
  ).toBe(true);
  fail = false;
  push.mockImplementation(() => {
    navigation.search = '';
  });
  const reset = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Clear selection and retry'
  );
  expect(reset).toBeDefined();
  await act(async () => {
    fireEvent(reset!, 'click');
  });
  expect(push).toHaveBeenCalledWith('/');
  await act(async () => root.render(createElement(ChronosTenantScope)));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(
    [...container.querySelectorAll('select')].some((select) => !select.hasAttribute('disabled'))
  ).toBe(true);
});
