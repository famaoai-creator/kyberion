import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { WorkspaceOverview, parseWorkspaceOverview } from './WorkspaceOverview';
import { ChronosTenantScope } from './ChronosTenantScope';

const navigation = vi.hoisted(() => ({ search: 'tenant=acme&organization_id=sales' }));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push }),
  usePathname: () => '/',
}));
vi.mock('../lib/hooks', () => ({ useChronosLocale: () => 'en' }));

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

it('announces pending control and failed outcome, and explains personal channel restrictions', async () => {
  const data = overview();
  data.selection.tier = 'personal';
  data.capabilities.canControlAutonomy = true;
  data.autonomy.dots[0].readiness = { ready: true, errors: [] };
  delete (data as Partial<typeof data>).links;
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(new Response(JSON.stringify(data)))
    )
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(createElement(WorkspaceOverview)));
  expect(container.textContent).toContain(
    'Conversation and uploads are unavailable for personal workspaces'
  );
  expect(
    [...container.querySelectorAll('a')].some((link) => link.textContent === 'Discuss goal')
  ).toBe(false);
  const resume = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Resume'
  );
  await act(async () => {
    fireEvent(resume!, 'click');
  });
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Waiting for the confirmed result'
  );
  await act(async () => {
    finish!(new Response(JSON.stringify({ ok: false, error: 'Control denied' }), { status: 403 }));
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Control denied');
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
});

const overview = () => ({
  ok: true,
  selection: {
    kind: 'organization',
    tenant_slug: 'acme',
    organization_id: 'sales',
    tier: 'confidential',
  },
  owner: { id: 'sales', name: 'Sales', kind: 'organization' },
  goal: 'Follow up',
  work: {
    items: [{ id: 'one', title: 'Draft', status: 'open' }],
    counts: { total: 1, active: 1, blocked: 0 },
  },
  library: { artifacts: [] },
  decisions: { approvals: [] },
  autonomy: {
    dots: [
      {
        id: 'dot',
        name: 'Follow up',
        goal: 'Daily follow up',
        status: 'paused',
        readiness: { ready: false, errors: ['Missing authority'] },
        budget: null,
      },
    ],
    pauseMeaning: 'future_wakeups_only',
    blockedReasons: [],
  },
  capabilities: { canControlAutonomy: false },
  unavailable: ['library'],
  links: { conversation: 'http://localhost:3050/?tenant=acme&organization_id=sales' },
});
describe('workspace overview wire contract', () => {
  it('preserves unknown sources and withheld budget instead of fabricating zero usage', () => {
    const parsed = parseWorkspaceOverview(overview());
    expect(parsed?.unavailable).toEqual(['library']);
    expect(parsed?.autonomy.dots[0].budget).toBeNull();
    expect(parsed?.autonomy.dots[0].readiness.errors).toEqual(['Missing authority']);
    expect(parsed?.capabilities.canControlAutonomy).toBe(false);
  });
  it('rejects malformed receipts and unsafe conversation navigation', () => {
    expect(parseWorkspaceOverview({ ...overview(), work: { counts: {}, items: [] } })).toBeNull();
    expect(
      parseWorkspaceOverview({ ...overview(), links: { conversation: 'javascript:alert(1)' } })
    ).toBeNull();
    expect(parseWorkspaceOverview({ ...overview(), unavailable: 'library' })).toBeNull();
  });
  it('preserves partial and unknown cost evidence and rejects invented statuses', () => {
    for (const costStatus of ['unknown', 'partial', 'complete']) {
      const data = overview();
      const dot = {
        ...data.autonomy.dots[0],
        budget: { tokens: 0, costUsd: 0, scope: 'system', throttle: 'normal', costStatus },
      };
      const parsed = parseWorkspaceOverview({
        ...data,
        autonomy: { ...data.autonomy, dots: [dot] },
      });
      if (costStatus === 'complete') expect(parsed).toBeNull();
      else expect(parsed?.autonomy.dots[0].budget?.costStatus).toBe(costStatus);
    }
  });
});

it.each([
  ['paused', 'Resume', 'resume'],
  ['draft', 'Activate', 'activate'],
])('renders %s and posts only the exact reviewed control scope', async (status, label, action) => {
  const data = overview();
  data.capabilities.canControlAutonomy = true;
  data.autonomy.dots[0].readiness = { ready: true, errors: [] };
  data.autonomy.dots[0].status = status;
  data.unavailable = ['work'];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : data), {
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => {
    root.render(createElement(WorkspaceOverview));
  });
  expect(container.textContent).toContain('Unavailable: work');
  expect(container.textContent).not.toContain('No work in this scope yet.');
  expect(container.textContent).toContain('Budget is unavailable');
  const resume = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label
  );
  expect(resume).toBeDefined();
  await act(async () => {
    fireEvent(resume!, 'click');
  });
  const post = calls.find((call) => call.init?.method === 'POST');
  expect(JSON.parse(String(post?.init?.body))).toEqual({
    tenant_slug: 'acme',
    organization_id: 'sales',
    tier: 'confidential',
    dot_id: 'dot',
    action,
  });
  expect(String(post?.init?.body)).not.toContain('"kind"');
});
