import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompanySetupController } from './company-setup-client';
import {
  companyActionAllowed,
  companyApprovalHref,
  companySetupHref,
  initialCompanyState,
  parseCompanySetup,
  type CompanySetup,
  type CompanyStage,
} from './company-setup-model';

const owner = (memberId = 'owner-a') => ({
  ok: true,
  member: { member_id: memberId, source: 'token', registered: true },
  viewing: null,
  write_tenant: null,
  available_operations: ['setup'],
  tenants: ['company-a', 'company-b'].map((tenant_slug) => ({
    tenant_slug,
    display_name: tenant_slug,
    role: 'owner',
    status: 'active',
  })),
});
const setup = (stage: CompanyStage = 'unregistered', tenantSlug = 'company-a'): CompanySetup => ({
  tenantSlug,
  companyName: 'Example Company',
  organizationId: stage === 'unregistered' ? '' : tenantSlug,
  verticals: ['software', 'consulting'],
  stage,
  firstWork: stage === 'unregistered' ? '' : 'Prepare a report',
  blockers: [],
  probePassed: false,
  probeSummary: [],
  canRequestActivation: false,
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function harness(initial: CompanySetup = setup()) {
  let server = initial;
  let me = owner();
  let context = 'page-a';
  const posts: Record<string, string>[] = [];
  let post = async (command: Record<string, string>) => {
    switch (command.action) {
      case 'preview_company':
      case 'preview_first_work':
        return json({
          ok: true,
          review: { digest: 'review-1', title: 'Review', summary: ['Exact plan'] },
        });
      case 'register_company':
        server = setup('registered');
        break;
      case 'probe':
        server = {
          ...server,
          probePassed: true,
          probeSummary: ['Ready'],
          canRequestActivation: true,
        };
        break;
      case 'request_activation':
        server = {
          ...server,
          stage: 'awaiting_approval',
          activationApproval: {
            id: 'approval-1',
            channel: 'concierge',
            presentedDigest: 'presented-1',
            status: 'pending',
          },
        };
        break;
      case 'apply_activation':
        server = { ...server, stage: 'active' };
        break;
      case 'apply_first_work':
        server = { ...server, stage: 'first_work_prepared' };
        break;
    }
    return json({ ok: true, setup: server });
  };
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/me') return json(me);
    if (!init?.method) return json({ ok: true, setup: server });
    const command = JSON.parse(String(init.body)) as Record<string, string>;
    posts.push(command);
    return post(command);
  });
  const controller = createCompanySetupController({
    request,
    context: () => context,
    timeoutMs: 1000,
  });
  return {
    controller,
    request,
    posts,
    setServer: (next: CompanySetup) => {
      server = next;
    },
    setMe: (next: ReturnType<typeof owner>) => {
      me = next;
    },
    setContext: (next: string) => {
      context = next;
    },
    setPost: (next: typeof post) => {
      post = next;
    },
  };
}
async function prepareRegistration(h: ReturnType<typeof harness>) {
  await h.controller.load('company-a');
  h.controller.updateDraft({ vertical: 'software', firstWork: 'Prepare a report' });
  await h.controller.act('preview_company');
}
afterEach(() => vi.useRealTimers());

describe('company setup explicit transitions', () => {
  it('registers, requests a human decision, applies activation, and only prepares first work', async () => {
    const h = harness();
    await prepareRegistration(h);
    expect(h.posts.map((command) => command.action)).toEqual(['preview_company']);
    expect(h.controller.getSnapshot().setup?.stage).toBe('unregistered');
    await h.controller.act('register_company');
    expect(h.controller.getSnapshot().setup?.stage).toBe('registered');
    await h.controller.act('request_activation');
    expect(h.posts).toHaveLength(2);
    await h.controller.act('probe');
    await h.controller.act('request_activation');
    expect(h.controller.getSnapshot().setup?.stage).toBe('awaiting_approval');
    await h.controller.act('apply_activation');
    expect(h.posts).toHaveLength(4);
    const current = h.controller.getSnapshot().setup!;
    h.setServer({
      ...current,
      activationApproval: { ...current.activationApproval!, status: 'approved' },
    });
    await h.controller.load();
    expect(h.posts).toHaveLength(4);
    await h.controller.act('apply_activation');
    expect(h.controller.getSnapshot().setup?.stage).toBe('active');
    await h.controller.act('apply_first_work');
    expect(h.posts).toHaveLength(5);
    await h.controller.act('preview_first_work');
    await h.controller.act('apply_first_work');
    expect(h.controller.getSnapshot().setup?.stage).toBe('first_work_prepared');
    expect(h.posts).toEqual([
      {
        action: 'preview_company',
        tenantSlug: 'company-a',
        vertical: 'software',
        firstWork: 'Prepare a report',
      },
      {
        action: 'register_company',
        tenantSlug: 'company-a',
        vertical: 'software',
        firstWork: 'Prepare a report',
        reviewDigest: 'review-1',
      },
      { action: 'probe', tenantSlug: 'company-a' },
      { action: 'request_activation', tenantSlug: 'company-a' },
      { action: 'apply_activation', tenantSlug: 'company-a', requestId: 'approval-1' },
      { action: 'preview_first_work', tenantSlug: 'company-a' },
      { action: 'apply_first_work', tenantSlug: 'company-a', reviewDigest: 'review-1' },
    ]);
  });
  it('clears review on edits, cancellation, or refresh without applying anything', async () => {
    const h = harness();
    await prepareRegistration(h);
    h.controller.updateDraft({ firstWork: 'Changed goal' });
    await h.controller.act('register_company');
    expect(h.posts).toHaveLength(1);
    await h.controller.act('preview_company');
    h.controller.dismissReview();
    expect(h.controller.getSnapshot().review).toBeNull();
    expect(h.posts).toHaveLength(2);
    await h.controller.act('preview_company');
    await h.controller.load();
    expect(h.controller.getSnapshot().review).toBeNull();
    expect(h.posts).toHaveLength(3);
  });
  it('blocks duplicate clicks synchronously and keeps the active request lock', async () => {
    const h = harness();
    await prepareRegistration(h);
    const gate = deferred<Response>();
    h.setPost(() => gate.promise);
    const first = h.controller.act('register_company');
    const duplicate = h.controller.act('register_company');
    await duplicate;
    await vi.waitFor(() => expect(h.posts).toHaveLength(2));
    expect(h.controller.getSnapshot().busy).toBe(true);
    await h.controller.verifyIdentity();
    await h.controller.refresh();
    expect(h.controller.getSnapshot().busy).toBe(true);
    gate.resolve(json({ ok: true, setup: setup('registered') }));
    await first;
    expect(h.controller.getSnapshot().busy).toBe(false);
    expect(h.posts).toHaveLength(2);
  });
  it('allows readiness blockers describing later steps when authoritative readiness permits a request', async () => {
    const h = harness({
      ...setup('registered'),
      blockers: ['Request human approval'],
      probePassed: true,
      canRequestActivation: true,
    });
    await h.controller.load('company-a');
    await h.controller.act('request_activation');
    expect(h.posts.map((value) => value.action)).toEqual(['request_activation']);
  });
});

describe('company setup interruption and identity fencing', () => {
  it('discards a stale mutation after tenant replacement and does not release a newer request', async () => {
    const h = harness();
    await prepareRegistration(h);
    const old = deferred<Response>();
    h.setPost(() => old.promise);
    const mutation = h.controller.act('register_company');
    await vi.waitFor(() => expect(h.posts).toHaveLength(2));
    const newRead = deferred<Response>();
    h.request.mockImplementationOnce(() => newRead.promise);
    const replacement = h.controller.load('company-b');
    old.resolve(json({ ok: true, setup: setup('registered') }));
    await mutation;
    expect(h.controller.getSnapshot()).toMatchObject({
      tenantSlug: 'company-b',
      busy: true,
      setup: null,
    });
    h.setServer(setup('unregistered', 'company-b'));
    newRead.resolve(json(owner()));
    await replacement;
    expect(h.controller.getSnapshot().setup?.tenantSlug).toBe('company-b');
    expect(h.controller.getSnapshot().review).toBeNull();
  });
  it.each(['before', 'during'] as const)(
    'invalidates changed navigation or credentials %s a write',
    async (when) => {
      const h = harness();
      await prepareRegistration(h);
      if (when === 'before') {
        h.setContext('page-b');
        await h.controller.act('register_company');
        expect(h.posts).toHaveLength(1);
      } else {
        const gate = deferred<Response>();
        h.setPost(() => gate.promise);
        const pending = h.controller.act('register_company');
        await vi.waitFor(() => expect(h.posts).toHaveLength(2));
        h.setContext('page-b');
        gate.resolve(json({ ok: true, setup: setup('registered') }));
        await pending;
      }
      expect(h.controller.getSnapshot()).toMatchObject({
        setup: null,
        review: null,
        notice: 'changed',
        needsRefresh: true,
        busy: false,
      });
    }
  );
  it('rechecks server identity before a POST and after a POST result', async () => {
    const h = harness();
    await prepareRegistration(h);
    h.setMe(owner('owner-b'));
    await h.controller.act('register_company');
    expect(h.posts).toHaveLength(1);
    expect(h.controller.getSnapshot().notice).toBe('changed');
    h.setMe(owner());
    await prepareRegistration(h);
    h.setPost(async () => {
      h.setMe(owner('owner-b'));
      return json({ ok: true, setup: setup('registered') });
    });
    await h.controller.act('register_company');
    expect(h.controller.getSnapshot()).toMatchObject({
      setup: null,
      review: null,
      notice: 'changed',
    });
  });
  it('keeps an unchanged draft on focus verification and clears it after membership changes', async () => {
    const h = harness();
    await prepareRegistration(h);
    await h.controller.verifyIdentity();
    expect(h.controller.getSnapshot().review?.digest).toBe('review-1');
    const me = owner();
    me.tenants[0].role = 'viewer';
    h.setMe(me);
    await h.controller.verifyIdentity();
    expect(h.controller.getSnapshot()).toMatchObject({
      setup: null,
      review: null,
      notice: 'changed',
    });
  });
  it('aborts on disposal and never notifies or accepts a late response', async () => {
    const h = harness();
    const gate = deferred<Response>();
    h.request.mockImplementationOnce(() => gate.promise);
    const notify = vi.fn();
    h.controller.subscribe(notify);
    const pending = h.controller.load('company-a');
    h.controller.dispose();
    const calls = notify.mock.calls.length;
    gate.resolve(json(owner()));
    await pending;
    expect(notify).toHaveBeenCalledTimes(calls);
    expect(h.controller.getSnapshot()).toEqual(initialCompanyState());
  });
});

describe('company setup failures require observation before another write', () => {
  it.each(['non-json', 'transport', 'bad-shape', 'wrong-tenant'] as const)(
    'handles an unknown %s POST outcome without retrying',
    async (mode) => {
      const h = harness();
      await prepareRegistration(h);
      h.setPost(async () => {
        if (mode === 'transport') throw new TypeError('Network failed');
        if (mode === 'non-json') return new Response('<html>Gateway error</html>', { status: 502 });
        if (mode === 'wrong-tenant')
          return json({ ok: true, setup: setup('registered', 'company-b') });
        return json({ ok: true });
      });
      await h.controller.act('register_company');
      expect(h.controller.getSnapshot()).toMatchObject({
        notice: 'uncertain',
        needsRefresh: true,
        review: null,
        busy: false,
      });
      await h.controller.act('register_company');
      await h.controller.act('preview_company');
      await h.controller.verifyIdentity();
      expect(h.posts).toHaveLength(2);
      h.setServer(setup('registered'));
      await h.controller.load();
      expect(h.controller.getSnapshot()).toMatchObject({ notice: null, needsRefresh: false });
      expect(h.controller.getSnapshot().setup?.stage).toBe('registered');
      expect(h.posts).toHaveLength(2);
    }
  );
  it('times out a stalled response body and ignores its later completion', async () => {
    const h = harness();
    await prepareRegistration(h);
    vi.useFakeTimers();
    const body = deferred<unknown>();
    h.setPost(async () => ({ ok: true, status: 200, json: () => body.promise }) as Response);
    const pending = h.controller.act('register_company');
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(h.controller.getSnapshot()).toMatchObject({
      notice: 'uncertain',
      needsRefresh: true,
      busy: false,
    });
    body.resolve({ ok: true, setup: setup('registered') });
    await Promise.resolve();
    expect(h.controller.getSnapshot().setup?.stage).toBe('unregistered');
    expect(h.posts).toHaveLength(2);
  });
  it('reports authentication failures without retaining action controls', async () => {
    const h = harness();
    await prepareRegistration(h);
    h.setPost(async () => json({ ok: false }, 401));
    await h.controller.act('register_company');
    expect(h.controller.getSnapshot()).toMatchObject({
      notice: 'expired',
      setup: null,
      tenants: [],
      needsRefresh: true,
    });
  });
  it('handles a non-JSON status response and does not guess a company', async () => {
    const h = harness();
    h.request.mockResolvedValueOnce(new Response('Sign in', { status: 200 }));
    await h.controller.load('company-a');
    expect(h.controller.getSnapshot()).toMatchObject({
      notice: 'failed',
      setup: null,
      busy: false,
    });
    expect(h.posts).toHaveLength(0);
  });
  it('does not silently switch away from an unavailable selected tenant', async () => {
    const h = harness();
    await h.controller.load('unowned-company');
    expect(h.controller.getSnapshot()).toMatchObject({ notice: 'forbidden', setup: null });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});

describe('company setup wire and link contracts', () => {
  it('blocks writes after interrupted registration rather than guessing it can be retried', () => {
    for (const registrationState of ['started', 'failed'] as const) {
      const state = {
        ...initialCompanyState('company-a'),
        setup: {
          ...setup('registered'),
          registrationState,
          probePassed: true,
          canRequestActivation: true,
        },
      };
      for (const action of [
        'preview_company',
        'register_company',
        'probe',
        'request_activation',
        'apply_activation',
        'preview_first_work',
        'apply_first_work',
      ] as const) {
        expect(companyActionAllowed(state, action)).toBe(false);
      }
    }
  });
  it('does not show a status response if server identity changed while it was loading', async () => {
    const h = harness();
    h.request.mockImplementation(async (path: string) => {
      if (path === '/api/me')
        return json(h.request.mock.calls.length === 1 ? owner() : owner('owner-b'));
      return json({ ok: true, setup: setup() });
    });
    await h.controller.load('company-a');
    expect(h.controller.getSnapshot()).toMatchObject({
      setup: null,
      notice: 'changed',
      needsRefresh: true,
    });
    expect(h.posts).toHaveLength(0);
  });

  it('fails closed on unknown stages, malformed approval records, or missing readiness evidence', () => {
    const base = setup();
    for (const patch of [
      { stage: 'executed' },
      { activationApproval: { status: 'approved' } },
      { probePassed: undefined },
      { probeSummary: 'ready' },
      { canRequestActivation: undefined },
    ])
      expect(
        parseCompanySetup({ ok: true, setup: { ...base, ...patch } }, base.tenantSlug)
      ).toBeNull();
  });
  it('requires a fresh review and separate approval confirmation', () => {
    const state = { ...initialCompanyState('company-a'), setup: setup('active') };
    expect(companyActionAllowed(state, 'apply_first_work')).toBe(false);
    expect(companyActionAllowed(state, 'preview_first_work')).toBe(true);
    expect(companyActionAllowed({ ...state, needsRefresh: true }, 'preview_first_work')).toBe(
      false
    );
  });
  it('links only the tenant and known approval anchor, without forwarding credentials', () => {
    expect(companySetupHref('company-a')).toBe('/setup/company?tenant=company-a');
    expect(
      companyApprovalHref({
        ...setup('awaiting_approval'),
        activationApproval: {
          id: 'APR-1',
          channel: 'concierge',
          presentedDigest: 'private-digest',
          status: 'pending',
        },
      })
    ).toBe('/?tenant=company-a#decide-approval-APR-1');
  });
});
