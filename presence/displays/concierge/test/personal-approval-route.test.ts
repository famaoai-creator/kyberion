/** Auth transport only is mocked; signed principals, installed NHI and approval IO are real. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { useOnboardingAuthorityFixture } from '../../../../tests/helpers/onboarding-authority-fixture.js';
import type { ConciergeViewerContext } from '../src/lib/viewer-context';
const transport = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/viewer-context', async (original) => ({
  ...(await original<typeof import('../src/lib/viewer-context')>()),
  resolveConciergeViewer: transport.resolve,
}));
const f = useOnboardingAuthorityFixture();
let server: typeof import('../src/lib/personal-approval-server');
let decisions: typeof import('../src/app/api/approvals/[id]/route');
let summary: typeof import('../src/app/api/summary/route');
let envelopes: typeof import('@agent/core/scope-envelope');
let helper: typeof import('@agent/core/governance/authenticated-personal-approvals');
let viewer: ConciergeViewerContext;
let inbox: typeof import('@agent/core/deliverable-inbox');
let outcomes: typeof import('../src/app/api/outcomes/[id]/route');
beforeAll(async () => {
  server = await import('../src/lib/personal-approval-server');
  decisions = await import('../src/app/api/approvals/[id]/route');
  summary = await import('../src/app/api/summary/route');
  envelopes = await import('@agent/core/scope-envelope');
  helper = await import('@agent/core/governance/authenticated-personal-approvals');
  inbox = await import('@agent/core/deliverable-inbox');
  outcomes = await import('../src/app/api/outcomes/[id]/route');
}, 60000);
beforeEach(() => {
  viewer = { ...f.viewer.scope, principal: f.viewer.principal, includeUntenanted: false };
  transport.resolve.mockImplementation(() => ({ context: viewer }));
});
function create() {
  return server.withConciergePersonalApprovals(viewer, () =>
    f.approvals.createApprovalRequest('sovereign_concierge', {
      channel: 'personal-review',
      requestedBy: f.installedId,
      threadTs: '1',
      correlationId: 'private-consent',
      scope: { scope_kind: 'system', tier: 'personal', nhi_id: f.installedId },
      draft: { title: 'Synthetic private development', summary: 'Private reviewed scope' },
      accountability: {
        finalDecision: 'human_only',
        payloadHash: 'b'.repeat(64),
        effectBinding: 'fixture-private-development',
      },
    })
  )!;
}
async function decide(id: string, digest: string) {
  return decisions.POST(
    new NextRequest('http://localhost:3050/api/approvals/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'personal-review',
        storageChannel: 'personal-review',
        decision: 'approved',
        presentedDigest: digest,
      }),
    }),
    { params: Promise.resolve({ id }) }
  );
}
describe('personal owner real approval route', () => {
  function notification() {
    return f.personal(() =>
      inbox.addInboxEntry({
        entryId: 'INBOX-PERSONAL-NOTICE',
        title: 'Synthetic private notice',
        summary: 'Only the installed owner may read this.',
        kind: 'operator_notification',
        scope: {
          tier: 'personal',
          owner_nhi: f.installedId,
          mission_id: 'MSN-PRIVATE-NOTICE',
          task_id: 'private-notice-task',
          session_id: 'private-notice-session',
        },
      })
    );
  }
  const outcome = (id: string, status: string, selection = 'personal') =>
    outcomes.POST(
      new NextRequest('http://localhost:3050/api/outcomes/' + id + '?tenant=' + selection, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
      { params: Promise.resolve({ id }) }
    );
  it('shows and marks the real owner personal notification without widening the tier mask', async () => {
    const entry = notification();
    viewer = { ...viewer, tierAccess: ['public'] };
    expect(inbox.listInboxEntries({ entryId: entry.entry_id })).toEqual([]);
    const home = await summary
      .GET(new NextRequest('http://localhost:3050/api/summary?tenant=personal'))
      .json();
    expect(home.summary.outcome_feed).toContainEqual(
      expect.objectContaining({
        entry_id: entry.entry_id,
        title: 'Synthetic private notice',
      })
    );
    expect(viewer.tierAccess).toEqual(['public']);
    const read = await outcome(entry.entry_id, 'read');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      ok: true,
      entry: {
        status: 'read',
        reviewed_by: 'user:owner',
        scope: entry.scope,
      },
    });
    const accepted = await outcome(entry.entry_id, 'accepted');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      entry: {
        status: 'accepted',
        acceptance_receipt: { actor_id: 'user:owner', authenticated: true },
      },
    });
  });
  it('keeps private notices hidden from foreign humans, agents, company and system selections', async () => {
    const entry = notification();
    const owner = viewer;
    for (const candidate of [
      { ...owner, principalId: 'foreign', memberId: 'foreign' },
      {
        ...owner,
        principal: {
          ...owner.principal!,
          actor: { ...owner.principal!.actor, kind: 'agent' as const },
        },
      },
    ]) {
      viewer = candidate;
      expect((await outcome(entry.entry_id, 'read')).status).toBe(404);
      const home = await summary
        .GET(new NextRequest('http://localhost:3050/api/summary?tenant=personal'))
        .json();
      expect(
        home.summary.outcome_feed.map((item: { entry_id: string }) => item.entry_id)
      ).not.toContain(entry.entry_id);
    }
    viewer = owner;
    expect((await outcome(entry.entry_id, 'read', 'fixture-a')).status).toBe(404);
    viewer = { ...owner, tenantSlugs: 'all' };
    expect((await outcome(entry.entry_id, 'read', 'shared')).status).toBe(404);
    expect(
      f.personal(() => inbox.listInboxEntries({ entryId: entry.entry_id, scope: entry.scope }))[0]
        .status
    ).toBe('unread');
  });
  it('shows the owner request through the actual UI summary and accepts their signed human decision', async () => {
    const record = create();
    expect(record).toBeTruthy();
    expect(f.approvals.loadApprovalRequest('personal-review', record.id)).toBeNull();
    const publicRecord = f.run(() =>
      f.approvals.createApprovalRequest('sovereign_concierge', {
        channel: 'personal-review',
        requestedBy: 'fixture-public-agent',
        threadTs: '2',
        correlationId: 'public-hidden',
        scope: { scope_kind: 'system', tier: 'public' },
        draft: { title: 'Public system approval', summary: 'System only' },
      })
    );
    const tenantResponse = summary.GET(
      new NextRequest('http://localhost:3050/api/summary?tenant=fixture-a')
    );
    const tenantBody = await tenantResponse.json();
    expect(tenantBody.summary.approval_queue.map((item: { id: string }) => item.id)).not.toContain(
      record.id
    );
    const response = summary.GET(
      new NextRequest('http://localhost:3050/api/summary?tenant=personal')
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary.approval_queue.map((item: { id: string }) => item.id)).not.toContain(
      publicRecord.id
    );
    const card = body.summary.approval_queue.find((item: { id: string }) => item.id === record.id);
    expect(card).toMatchObject({ title: 'Synthetic private development' });
    const result = await decide(record.id, card.presented_digest);
    expect(await result.json()).toMatchObject({
      ok: true,
      approval: { status: 'approved', decidedBy: 'user:owner' },
    });
    expect(
      server.withConciergePersonalApprovals(viewer, () =>
        f.approvals.loadApprovalRequest('personal-review', record.id)
      )?.status
    ).toBe('approved');
  });
  it('admits the signed-in owner even when the concierge tier mask excludes personal', () => {
    const record = create();
    // Admission is the installed-owner proof (member + signed human principal);
    // the concierge tierAccess mask never lists personal for any role, so an
    // owner session carrying the public mask must still reach their own
    // partition. The real ceiling is the parent scope envelope — a public
    // envelope still refuses below.
    viewer = { ...viewer, tierAccess: ['public'] };
    expect(server.loadConciergeApproval(viewer, 'personal-review', record.id)?.id).toBe(record.id);
  });
  it('refuses foreign humans and NHI principals without exposing the private request', async () => {
    const record = create();
    const digest = f.approvals.computeApprovalPresentedDigest(record);
    const owner = viewer;
    for (const candidate of [
      { ...owner, principalId: 'foreign', memberId: 'foreign' },
      {
        ...owner,
        principal: {
          ...owner.principal!,
          actor: { ...owner.principal!.actor, kind: 'agent' as const },
        },
      },
    ]) {
      viewer = candidate;
      expect(server.loadConciergeApproval(viewer, 'personal-review', record.id)).toBeNull();
      expect((await decide(record.id, digest)).status).toBe(404);
    }
  });
  it('cannot elevate a public scope or mint personal visibility from a guessed plain principal', () => {
    expect(helper.withAuthenticatedPersonalApprovals(f.principal, () => true)).toBeNull();
    const publicScope = envelopes.mintScopeEnvelope({
      identity: { tier: 'public', session_id: 'public-worker' },
      policy: { read_tiers: ['public'], write_tier: 'public', purpose: 'fixture public ceiling' },
      env: { ...process.env, KYBERION_TIER: 'public' },
    });
    expect(
      envelopes.withScopeEnvelope(publicScope, () =>
        server.withConciergePersonalApprovals(viewer, () => true)
      )
    ).toBeNull();
  });
});
