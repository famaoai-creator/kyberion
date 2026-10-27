import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { OrganizationDashboard } from './OrganizationDashboard';

const navigation = vi.hoisted(() => ({
  search: 'tenant=acme&organization_id=sales&project_id=project-a',
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock('../lib/hooks', () => ({ useChronosLocale: () => 'ja' }));
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
  navigation.search = 'tenant=acme&organization_id=sales&project_id=project-a';
});
afterAll(() => dom.restore());
function data(mode = 'scope', title = '停滞した仕事') {
  return {
    ok: true,
    mode,
    generatedAt: '2026-10-27T01:00:00Z',
    selection: {
      kind: 'project',
      tenant_slug: 'acme',
      organization_id: 'sales',
      project_id: 'project-a',
    },
    viewer: {
      id: 'alice',
      role: 'readonly',
      tenants: ['acme'],
      organizations: ['sales'],
      projects: ['project-a'],
      tiers: ['confidential'],
    },
    available: { mine: true, organization: false },
    counts: { active: 0, blocked: 1, review: 0, ready: 0, total: 1 },
    attentionTotal: 1,
    attention: [{ id: 'one', title, status: 'blocked', updatedAt: '2026-10-27T01:00:00Z' }],
  };
}
async function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(createElement(OrganizationDashboard)));
  return { container, root };
}
it('shows Japanese scope, identity and next action; disables unavailable organization view', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(data())))
  );
  const { container } = await mount();
  expect(container.textContent).toContain('組織ダッシュボード');
  expect(container.textContent).toContain('閲覧者: alice');
  expect(container.textContent).toContain('プロジェクト: project-a');
  expect(container.textContent).toContain('阻害要因を確認');
  expect(container.textContent).toContain('取得時刻');
  expect(container.textContent).toContain('着手可能');
  expect(container.textContent).not.toContain('{missions}');
  expect(container.textContent).not.toContain('Dashboard を更新しました');
  const organization = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === '組織全体'
  );
  expect(organization?.hasAttribute('disabled')).toBe(true);
});
it('withdraws old rows immediately when the scope changes, ignoring delayed prior responses', async () => {
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(data())))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(data('scope', '新しい範囲'))))
  );
  const { container, root } = await mount();
  navigation.search = 'tenant=acme&organization_id=sales&project_id=project-b';
  await act(async () => root.render(createElement(OrganizationDashboard)));
  expect(container.textContent).not.toContain('停滞した仕事');
  navigation.search = 'tenant=acme&organization_id=sales&project_id=project-c';
  await act(async () => root.render(createElement(OrganizationDashboard)));
  await act(async () => finish!(new Response(JSON.stringify(data('scope', '遅れた応答')))));
  expect(container.textContent).toContain('新しい範囲');
  expect(container.textContent).not.toContain('遅れた応答');
});
it('requests My work without sending a client user id and clears rows on failed refresh', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(data())))
    .mockResolvedValueOnce(new Response(JSON.stringify(data('mine', '本人の仕事'))))
    .mockResolvedValueOnce(new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  const { container } = await mount();
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
  await act(async () => fireEvent(button('自分'), 'click'));
  expect(String(fetcher.mock.calls[1][0])).toContain('mode=mine');
  expect(String(fetcher.mock.calls[1][0])).not.toContain('alice');
  expect(container.textContent).toContain('本人の仕事');
  await act(async () => fireEvent(button('更新'), 'click'));
  expect(container.textContent).not.toContain('本人の仕事');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('件数は不明');
});

it('uses resolved organization parents when switching from a project-only URL', async () => {
  navigation.search = 'project_id=project-a';
  const initial = data();
  initial.available.organization = true;
  const organization = data('organization');
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(initial)))
    .mockResolvedValueOnce(new Response(JSON.stringify(organization)));
  vi.stubGlobal('fetch', fetcher);
  const { container } = await mount();
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === '組織全体'
  )!;
  await act(async () => fireEvent(button, 'click'));
  const target = new URL(String(fetcher.mock.calls[1][0]), 'http://localhost');
  expect(target.searchParams.get('organization_id')).toBe('sales');
  expect(target.searchParams.get('tenant')).toBe('acme');
  expect(target.searchParams.has('project_id')).toBe(false);
  expect(target.searchParams.get('mode')).toBe('organization');
});

it('renders a recoverable failure for malformed successful payloads', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, mode: 'scope', viewer: {}, counts: {}, attention: [] })
        )
    )
  );
  const { container } = await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('件数は不明');
});
