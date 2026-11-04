import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import { buildDecisionBrief } from '@agent/core/surface/decision-brief';
import { PersonalOverview } from '../src/app/personal-overview';

/**
 * The personal (all-company) inbox lists the actual pending decisions of every
 * company, most urgent first, with the company badge, and decides them through
 * the tenant-scoped decision route with the presented digest — the server
 * re-resolves the viewer for that tenant.
 */

function approval(id: string, tenant: string, title: string, expiresAt?: string) {
  const record = {
    id,
    kind: 'mission_gate',
    channel: 'external-operation',
    title: 'Approval required: vcs:pr_create',
    summary: 'Task: vcs:pr_create',
    status: 'pending',
    requestedBy: 'vcs-publication-cli',
    requestedAt: '2026-10-27T17:24:57.597Z',
    ...(expiresAt ? { expiresAt } : {}),
    accountability: { finalDecision: 'human_only', effectBinding: 'vcs:pr_create' },
    scope: { tenant_slug: tenant },
  } as never;
  return {
    id,
    channel: 'external-operation',
    storage_channel: 'external-operation',
    title: 'Approval required: vcs:pr_create',
    reason: 'Task: vcs:pr_create',
    requested_at: '2026-10-27T17:24:57.597Z',
    tenant_slug: tenant,
    presented_digest: `digest-${id}`,
    brief: buildDecisionBrief(record, {
      publication: { repository: 'acme/app', title },
      now: Date.parse('2026-11-01T00:00:00Z'),
    }),
  };
}

const counts = (pending: number) => ({
  active_missions: 1,
  pending_approvals: pending,
  unread_outcomes: 0,
  exceptions: 0,
});

const aggregate = {
  ok: true,
  companies: [
    {
      tenant_slug: 'acme',
      display_name: 'Acme',
      counts: counts(3),
      approvals: [approval('late', 'acme', 'Late PR')],
    },
    {
      tenant_slug: 'beta',
      display_name: 'Beta',
      counts: counts(1),
      approvals: [approval('soon', 'beta', 'Soon PR', '2099-01-01T00:00:00Z')],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom({
    sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    localStorage: { getItem: () => null, setItem: vi.fn() },
  });
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
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });

describe('PersonalOverview', () => {
  it('lists every company’s decisions by urgency and decides through the scoped route', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/personal-summary') return json(aggregate);
        if (url.startsWith('/api/approvals/')) {
          posts.push({ url, body: JSON.parse(String(init?.body)) });
          return json({ ok: true });
        }
        return json({ ok: false }, 404);
      })
    );
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = client.createRoot(container as unknown as Element);
    act(() => root.render(createElement(PersonalOverview, { locale: 'ja' })));
    unmount = () => act(() => root.unmount());
    await flush();

    const text = container.textContent;
    // Actual decisions, not per-company counts; the deadline-bound one first.
    const soon = text.indexOf('acme/app に PR「Soon PR」を作成してよいですか');
    const late = text.indexOf('acme/app に PR「Late PR」を作成してよいですか');
    expect(soon).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(soon);
    expect(text).toContain('Beta');
    expect(text).toContain('Acme にはほかに 2 件あります');
    // Machine text only inside the collapsed 詳細 disclosure, never the card body.
    const hidden = container
      .querySelectorAll('details')
      .reduce((all, details) => all.replace(details.textContent, ''), text);
    expect(hidden).not.toContain('Approval required');
    expect(text).toContain('Approval required');

    const approve = container
      .querySelectorAll('button')
      .find((button) => button.textContent === '承認する');
    expect(approve).toBeDefined();
    await act(async () => {
      fireEvent(approve!, 'click');
    });
    await flush();
    expect(posts).toEqual([
      {
        url: '/api/approvals/soon',
        body: {
          decision: 'approved',
          channel: 'external-operation',
          storageChannel: 'external-operation',
          presentedDigest: 'digest-soon',
        },
      },
    ]);
  });
});
