import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import {
  installFakeDom,
  fireEvent,
  serializeFake,
} from '../../../../libs/shared-ui/vanilla/fake-dom.test-support.js';
import {
  managementDescription,
  ManagementFence,
  missionLink,
  parseManagement,
  submitManagement,
  type Mutation,
} from '../src/app/management/management-client';
const auth = vi.hoisted(() => ({ token: 'owner', revision: 0, memberId: 'member-a' }));
vi.mock('../src/lib/front-desk-auth-token', () => ({
  getFrontDeskAuthRevision: () => auth.revision,
  readFrontDeskRequestToken: () => auth.token,
}));
vi.mock('../src/lib/use-concierge-i18n', () => ({
  useConciergeI18n: () => ({ t: (key: string) => key }),
}));
import ManagementPage from '../src/app/management/page';
const scope = { tenant: 'alpha', organizationId: 'org-a', projectId: 'project-a' };
const snapshot = () => ({
  ok: true as const,
  contextId: 'a'.repeat(64),
  actorId: 'user:member-a',
  selected: scope,
  canManage: true,
  tenants: [{ slug: 'alpha', name: 'Alpha' }],
  organizations: [{ id: 'org-a', name: 'Organization A', status: 'active' }],
  projects: [{ id: 'project-a', name: 'Project A', organization_id: 'org-a', status: 'active' }],
  capabilities: {
    createOrganization: true,
    createProject: true,
    editOrganization: true,
    editProject: true,
  },
  organization: {
    id: 'org-a',
    name: 'Organization A',
    purpose: 'Purpose',
    version: 'version-a',
    status: 'active',
  },
  project: {
    id: 'project-a',
    name: 'Project A',
    summary: 'Summary',
    version: 'version-p',
    status: 'active',
  },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tenant = { tenant_slug: 'alpha', display_name: 'Alpha', role: 'owner', status: 'active' };
let dom: ReturnType<typeof installFakeDom>;
let client: typeof import('react-dom/client');
let unmount: (() => void) | undefined;
beforeAll(async () => {
  dom = installFakeDom({
    location: { search: '?tenant=alpha&organization_id=org-a&project_id=project-a' },
    setInterval,
    clearInterval,
  });
  client = await import('react-dom/client');
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  auth.token = 'owner';
  auth.revision = 0;
  auth.memberId = 'member-a';
  vi.unstubAllGlobals();
});
afterAll(() => dom.restore());
function serve(post?: (init: RequestInit) => Promise<Response>, read?: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      if (path === '/api/me')
        return json({
          ok: true,
          viewing: tenant,
          tenants: [tenant],
          member: { member_id: auth.memberId, source: 'token', registered: true },
          write_tenant: 'alpha',
          available_operations: [],
        });
      if (path.startsWith('/api/management'))
        return init.method === 'POST' ? post!(init) : read?.() || json(snapshot());
      if (path === '/api/front-desk/links')
        return json({ ok: true, chronos_url: 'https://chronos.example/' });
      return json({ ok: false }, 404);
    })
  );
}
async function mount() {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = client.createRoot(container as unknown as Element);
  unmount = () => act(() => root.unmount());
  await act(async () => root.render(createElement(ManagementPage)));
  const click = async (label: string) => {
    const button = container
      .querySelectorAll('button')
      .find((node) => serializeFake(node).includes(label));
    if (!button) throw new Error('Missing button ' + label);
    await act(async () => {
      fireEvent(button, 'click');
    });
  };
  const reviewEdit = async () => {
    await click('management.edit_organization');
    await act(async () => {
      fireEvent(container.querySelector('form')!, 'submit');
    });
  };
  return { container, click, reviewEdit, text: () => serializeFake(container) };
}
const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
describe('management client boundaries', () => {
  it('rejects malformed capabilities and non-string versions', () => {
    expect(parseManagement(snapshot())).not.toBeNull();
    expect(parseManagement({ ...snapshot(), capabilities: {} })).toBeNull();
    expect(
      parseManagement({ ...snapshot(), organization: { ...snapshot().organization, version: 3 } })
    ).toBeNull();
  });
  it('removes credentials and keeps canonical scope on verified mission links', () => {
    const href = missionLink(
      { ok: true, chronos_url: 'https://chronos.example/?token=secret#secret' },
      scope
    )!;
    expect(href).not.toContain('secret');
    expect(href).toContain('organization_id=org-a');
    expect(href).toContain('section=missions');
    expect(missionLink({ ok: true, chronos_url: 'javascript:alert(1)' }, scope)).toBeNull();
    expect(
      missionLink({ ok: true, chronos_url: 'https://user:secret@chronos.example/' }, scope)
    ).toBeNull();
  });
  it('aborts interrupted generations and rejects same-token auth revisions', () => {
    const fence = new ManagementFence();
    const before = fence.begin();
    fence.reset();
    expect(before.signal.aborted).toBe(true);
    expect(before.current()).toBe(false);
    const after = fence.begin();
    auth.revision++;
    expect(after.current()).toBe(false);
  });
  it('submits only operation-specific fields, with no automatic retry', async () => {
    serve(async () => {
      throw new Error('network');
    });
    const input: Mutation = {
      ...scope,
      operation: 'organization.create',
      requestId: 'request-1',
      contextId: 'a'.repeat(64),
      name: 'New',
      purpose: 'Purpose',
    };
    await expect(submitManagement(input, new AbortController().signal)).rejects.toThrow('network');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({
      tenant: 'alpha',
      operation: 'organization.create',
      requestId: 'request-1',
      contextId: 'a'.repeat(64),
      name: 'New',
      purpose: 'Purpose',
    });
  });
});
describe('management page confirmed mutation lifecycle', () => {
  it('requires review and retains the request ID for an explicit retry', async () => {
    serve(async () => {
      throw new Error('network');
    });
    const view = await mount();
    await view.reviewEdit();
    expect(posts()).toHaveLength(0);
    await view.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(view.text()).toContain('management.uncertain');
    await view.click('management.retry');
    expect(posts()).toHaveLength(2);
    expect(posts()[1][1]!.body).toBe(posts()[0][1]!.body);
    expect(JSON.parse(String(posts()[0][1]!.body)).expectedVersion).toBe('version-a');
  });
  it('clears stale drafts and requires a fresh read after conflict', async () => {
    serve(async () => json({ ok: false, error_code: 'conflict' }, 409));
    const view = await mount();
    await view.reviewEdit();
    await view.click('management.confirm_save');
    expect(view.text()).toContain('management.conflict');
    expect(view.text()).not.toContain('management.confirm_save');
    expect(posts()).toHaveLength(1);
    await view.click('management.refresh');
    expect(view.text()).toContain('management.edit_organization');
  });
  it('does not double-submit and preserves committed audit-pending receipt when refresh fails', async () => {
    let resolve!: (response: Response) => void;
    let committed = false;
    const deferred = new Promise<Response>((yes) => {
      resolve = yes;
    });
    serve(
      async () => deferred,
      () => (committed ? json({ ok: false }, 500) : json(snapshot()))
    );
    const view = await mount();
    await view.reviewEdit();
    await view.click('management.confirm_save');
    await view.click('management.saving');
    expect(posts()).toHaveLength(1);
    committed = true;
    await act(async () =>
      resolve(
        json({
          ok: true,
          result: { organizationId: 'org-a', version: 'new', replayed: false, auditPending: true },
        })
      )
    );
    expect(view.text()).toContain('management.audit_pending');
    expect(view.text()).toContain('management.failed');
    expect(view.text()).toContain('management.retry_audit');
    expect(view.text()).not.toContain('management.confirm_save');
  });
  it('clears a confirmation when sign-in changes and never submits it', async () => {
    serve(async () => json({ ok: false }, 403));
    const view = await mount();
    await view.reviewEdit();
    auth.revision++;
    await view.click('management.confirm_save');
    expect(posts()).toHaveLength(0);
    expect(view.text()).toContain('management.changed');
    expect(view.text()).not.toContain('Organization A');
  });
});

describe('management external scope changes', () => {
  it('clears confirmation immediately on rail tenant changes', async () => {
    serve(async () => json({ ok: false }, 500));
    const view = await mount();
    await view.reviewEdit();
    await act(async () =>
      fireEvent(dom.windowEvents, 'front-desk:tenant-changed', { detail: { tenant: 'beta' } })
    );
    expect(view.text()).not.toContain('management.confirm_save');
    expect(posts()).toHaveLength(0);
    expect(
      vi.mocked(fetch).mock.calls.some(([path]) => String(path) === '/api/management?tenant=beta')
    ).toBe(true);
  });
  it('ignores a late mutation completion after the rail switches tenant', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((yes) => {
      resolve = yes;
    });
    serve(async () => pending);
    const view = await mount();
    await view.reviewEdit();
    await view.click('management.confirm_save');
    await act(async () =>
      fireEvent(dom.windowEvents, 'front-desk:tenant-changed', { detail: { tenant: 'beta' } })
    );
    await act(async () =>
      resolve(
        json({ ok: true, result: { organizationId: 'org-a', version: 'new', replayed: false } })
      )
    );
    expect(view.text()).not.toContain('management.saved');
    expect(view.text()).not.toContain('management.confirm_save');
    expect(posts()).toHaveLength(1);
  });
});

describe('management cookie identity fencing', () => {
  it('does not transfer a confirmed draft to a replacement cookie principal', async () => {
    serve(async () =>
      json({ ok: true, result: { organizationId: 'org-a', version: 'new', replayed: false } })
    );
    const view = await mount();
    await view.reviewEdit();
    auth.memberId = 'member-b';
    await view.click('management.confirm_save');
    expect(posts()).toHaveLength(0);
    expect(view.text()).toContain('management.changed');
    expect(view.text()).not.toContain('Organization A');
  });
});

describe('organization purpose approval disclosure', () => {
  it('shows reapproval consequence before submitting a changed purpose', async () => {
    serve(async () => json({ ok: false }, 500));
    const view = await mount();
    await view.click('management.edit_organization');
    const field = view.container.querySelector('textarea')!;
    await act(async () => {
      (field as unknown as { value: string }).value = 'Updated purpose';
      fireEvent(field, 'input');
    });
    await act(async () => fireEvent(view.container.querySelector('form')!, 'submit'));
    expect(view.text()).toContain('management.purpose_reapproval');
    expect(posts()).toHaveLength(0);
  });
});

describe('management server snapshot context binding', () => {
  it('rejects missing snapshot bindings', () => {
    expect(parseManagement({ ...snapshot(), contextId: undefined })).toBeNull();
    expect(parseManagement({ ...snapshot(), actorId: undefined })).toBeNull();
    expect(parseManagement({ ...snapshot(), contextId: 'arbitrary' })).toBeNull();
  });
  it('rejects a GET snapshot from a different actor before rendering it', async () => {
    serve(undefined, () =>
      json({ ...snapshot(), actorId: 'user:member-b', contextId: 'b'.repeat(64) })
    );
    const view = await mount();
    expect(view.text()).toContain('management.changed');
    expect(view.text()).not.toContain('Organization A');
  });
  it('clears cookie-owned drafts on focus without submitting', async () => {
    serve(async () => json({ ok: false }, 403));
    const view = await mount();
    await view.reviewEdit();
    auth.memberId = 'member-b';
    await act(async () => fireEvent(dom.windowEvents, 'focus'));
    expect(view.text()).toContain('management.changed');
    expect(view.text()).not.toContain('management.confirm_save');
    expect(posts()).toHaveLength(0);
  });
  it('retains captured context across a cookie swap after precheck and surfaces server rejection', async () => {
    serve(async (init) => {
      const command = JSON.parse(String(init.body));
      expect(command.contextId).toBe('a'.repeat(64));
      expect(auth.memberId).toBe('member-b');
      return json({ ok: false, error_code: 'forbidden' }, 403);
    });
    const view = await mount();
    await view.reviewEdit();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (path === '/api/me') auth.memberId = 'member-b';
      return response;
    });
    await view.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(view.text()).toContain('management.forbidden');
    expect(view.text()).not.toContain('management.saved');
    expect(view.text()).not.toContain('management.confirm_save');
  });
});

describe('management partial edits and committed recovery', () => {
  it('omits untouched descriptions and permits optional org purpose without allowing text erasure', () => {
    const data = snapshot();
    expect(managementDescription('organization.update', 'Purpose', data).fields).toEqual({});
    expect(managementDescription('project.update', 'Summary', data).fields).toEqual({});
    expect(managementDescription('organization.create', '', data)).toMatchObject({
      valid: true,
      fields: {},
    });
    expect(managementDescription('project.create', '', data).valid).toBe(false);
    expect(managementDescription('organization.update', '', data).valid).toBe(false);
    expect(managementDescription('project.update', '', data).valid).toBe(false);
    expect(
      managementDescription('organization.update', '', {
        ...data,
        organization: { ...data.organization, purpose: '' },
      })
    ).toMatchObject({ valid: true, fields: {} });
  });
  it('allows name-only edit of an organization without a purpose and omits its approval-sensitive field', async () => {
    serve(
      async () => json({ ok: false }, 500),
      () => json({ ...snapshot(), organization: { ...snapshot().organization, purpose: '' } })
    );
    const view = await mount();
    await view.reviewEdit();
    expect(view.text()).toContain('management.description_unchanged');
    expect(view.text()).not.toContain('management.purpose_reapproval');
    await view.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]!.body))).not.toHaveProperty('purpose');
  });
  it('refreshes the newly created organization after its first committed refresh fails', async () => {
    let committed = false;
    serve(
      async () => {
        committed = true;
        return json({
          ok: true,
          result: { organizationId: 'org-new', version: 'new', replayed: false },
        });
      },
      () => (committed ? json({ ok: false }, 500) : json(snapshot()))
    );
    const view = await mount();
    await view.click('management.create_organization');
    const field = view.container.querySelector('input')!;
    await act(async () => {
      (field as unknown as { value: string }).value = 'New organization';
      fireEvent(field, 'input');
    });
    await act(async () => fireEvent(view.container.querySelector('form')!, 'submit'));
    await view.click('management.confirm_save');
    expect(view.text()).toContain('management.saved');
    expect(view.text()).toContain('management.failed');
    await view.click('management.refresh');
    const reads = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([path, init]) => String(path).startsWith('/api/management?') && init?.method !== 'POST'
      );
    expect(String(reads.at(-1)![0])).toBe('/api/management?tenant=alpha&organization_id=org-new');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]!.body))).not.toHaveProperty('purpose');
  });
  it('explicitly retries only the same committed audit request and clears the retry when complete', async () => {
    let count = 0;
    serve(async () => {
      count++;
      return json({
        ok: true,
        result: {
          organizationId: 'org-a',
          version: 'new',
          replayed: count > 1,
          ...(count === 1 ? { auditPending: true } : {}),
        },
      });
    });
    const view = await mount();
    await view.reviewEdit();
    await view.click('management.confirm_save');
    expect(posts()).toHaveLength(1);
    expect(view.text()).toContain('management.retry_audit');
    await view.click('management.retry_audit');
    expect(posts()).toHaveLength(2);
    expect(posts()[1][1]!.body).toBe(posts()[0][1]!.body);
    expect(view.text()).toContain('management.saved');
    expect(view.text()).not.toContain('management.retry_audit');
    expect(view.text()).not.toContain('management.audit_pending');
  });
});
