import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
  serializeFake,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
const auth = vi.hoisted(() => ({ token: 'synthetic-owner', revision: 0, memberId: 'owner' }));
vi.mock('../src/lib/front-desk-auth-token', () => ({
  getFrontDeskAuthRevision: () => auth.revision,
  readFrontDeskRequestToken: () => auth.token,
}));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ t: (key: string) => key }),
}));
import { OrganizationParticipantsPanel } from '../src/app/management/OrganizationParticipantsPanel';
import { parseParticipants } from '../src/app/management/participants-client';
import type { ManagementData } from '../src/app/management/management-client';

const scope = { tenant: 'alpha', organizationId: 'org-a', projectId: '' };
const management = (): ManagementData => ({
  ok: true,
  contextId: 'a'.repeat(64),
  actorId: 'user:owner',
  selected: scope,
  canManage: true,
  tenants: [{ slug: 'alpha', name: 'Alpha' }],
  organizations: [{ id: 'org-a', name: 'Organization A', status: 'active' }],
  projects: [],
  capabilities: {
    createOrganization: true,
    createProject: true,
    editOrganization: true,
    editProject: false,
  },
  organization: {
    id: 'org-a',
    name: 'Organization A',
    purpose: 'Purpose',
    status: 'active',
    version: 'v1',
  },
  project: null,
});
const owner = {
  actor: 'user:owner',
  display_name: 'Synthetic operator',
  kind: 'human',
  identity_status: 'active',
  is_local_owner: true,
};
const snapshot = () => ({
  ok: true,
  contextId: 'a'.repeat(64),
  actorId: 'user:owner',
  ...scope,
  candidates: [owner],
  participants: [
    {
      ...owner,
      organization_id: 'org-a',
      role_ids: ['planner', 'reviewer'],
      status: 'active',
      version: 'assignment-v1',
    },
  ],
  agents: [],
  roles: [
    { role_id: 'planner', name: 'Planner' },
    { role_id: 'reviewer', name: 'Reviewer' },
  ],
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom({
    location: { search: '?tenant=alpha&organization_id=org-a' },
    setInterval,
    clearInterval,
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  auth.memberId = 'owner';
  auth.token = 'synthetic-owner';
  auth.revision = 0;
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());
function serve(options: { post?: () => Response | Promise<Response>; get?: () => Response } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      if (path === '/api/me')
        return json({
          ok: true,
          member: { member_id: auth.memberId, source: 'token', registered: true },
          viewing: { tenant_slug: 'alpha', display_name: 'Alpha', role: 'owner', status: 'active' },
          tenants: [
            { tenant_slug: 'alpha', display_name: 'Alpha', role: 'owner', status: 'active' },
          ],
          available_operations: [],
          write_tenant: 'alpha',
        });
      if (path.startsWith('/api/management/participants'))
        return init.method === 'POST'
          ? ((await options.post?.()) ?? json({ ok: true }))
          : (options.get?.() ?? json(snapshot()));
      return json({ ok: false }, 404);
    })
  );
}
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
async function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      createElement(OrganizationParticipantsPanel, {
        scope,
        management: management(),
        disabled: false,
      })
    )
  );
  const click = async (label: string) => {
    const button = container
      .querySelectorAll('button')
      .find((node) => serializeFake(node).includes(label));
    if (!button) throw new Error('Missing button ' + label + ': ' + serializeFake(container));
    await act(async () => {
      fireEvent(button, 'click');
    });
  };
  return { click, text: () => serializeFake(container) };
}
describe('organization participant UI and identity fencing', () => {
  it('validates scope-bound rows and rejects malformed revisions or cross-tenant agents', () => {
    expect(parseParticipants(snapshot())).not.toBeNull();
    expect(
      parseParticipants({
        ...snapshot(),
        participants: [{ ...snapshot().participants[0], organization_id: 'other' }],
      })
    ).toBeNull();
    expect(
      parseParticipants({
        ...snapshot(),
        participants: [{ ...snapshot().participants[0], version: 3 }],
      })
    ).toBeNull();
    expect(
      parseParticipants({
        ...snapshot(),
        agents: [
          {
            nhi_id: 'nhi',
            display_name: 'Agent',
            kind: 'agent',
            lifecycle_status: 'active',
            accountable_human_id: 'user:owner',
            home_organization_id: 'org-a',
            tenant_slug: 'beta',
            version: 'v1',
          },
        ],
      })
    ).toBeNull();
  });
  it('shows the local operator and plural roles; mutation requires a separate confirmation', async () => {
    serve();
    const ui = await mount();
    expect(ui.text()).toContain('Synthetic operator');
    expect(ui.text()).toContain('people.local_operator');
    expect(ui.text()).toContain('Planner / Reviewer');
    expect(posts()).toHaveLength(0);
    await ui.click('people.edit_roles');
    await ui.click('management.review');
    expect(posts()).toHaveLength(0);
    expect(ui.text()).toContain('management.confirm_save');
    await ui.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({
      tenant: 'alpha',
      organizationId: 'org-a',
      contextId: 'a'.repeat(64),
      operation: 'participant.assign',
      actor: 'user:owner',
      roleIds: ['planner', 'reviewer'],
      expectedVersion: 'assignment-v1',
    });
    expect(ui.text()).toContain('management.saved');
  });
  it('does not save when the verified human changes before confirmation', async () => {
    serve();
    const ui = await mount();
    await ui.click('people.remove_assignment');
    auth.memberId = 'other-owner';
    await ui.click('management.confirm_save');
    expect(posts()).toHaveLength(0);
    expect(ui.text()).toContain('management.forbidden');
    expect(ui.text()).not.toContain('Synthetic operator');
  });
  it('rejects a response for another scope without rendering its identities', async () => {
    serve({
      get: () =>
        json({
          ...snapshot(),
          organizationId: 'org-b',
          candidates: [{ ...owner, display_name: 'Hidden person' }],
        }),
    });
    const ui = await mount();
    expect(ui.text()).toContain('management.forbidden');
    expect(ui.text()).not.toContain('Hidden person');
  });
  it('does not retry uncertain writes or claim that they were saved', async () => {
    serve({
      post: () => {
        throw new Error('Lost response');
      },
    });
    const ui = await mount();
    await ui.click('people.remove_assignment');
    await ui.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(ui.text()).toContain('management.uncertain');
    expect(ui.text()).not.toContain('management.saved');
    await ui.click('management.refresh');
    expect(posts()).toHaveLength(1);
  });
  it('preserves a failed refresh diagnostic after a confirmed mutation', async () => {
    let committed = false;
    serve({
      post: () => {
        committed = true;
        return json({ ok: true });
      },
      get: () => (committed ? json({ ok: false }, 503) : json(snapshot())),
    });
    const ui = await mount();
    await ui.click('people.remove_assignment');
    await ui.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(ui.text()).toContain('management.failed');
    expect(ui.text()).not.toContain('management.saved');
  });
});
