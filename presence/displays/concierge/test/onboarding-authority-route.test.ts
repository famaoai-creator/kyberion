import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as path from 'node:path';
import { safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { useOnboardingAuthorityFixture } from '../../../../tests/helpers/onboarding-authority-fixture.js';
import type { ConciergeViewerContext } from '../src/lib/viewer-context';
const transport = vi.hoisted(() => ({ resolve: vi.fn() }));
// Authentication transport/CSRF only. Actual profiles, owner adapter, facade,
// approval signatures, separation of duties and charter persistence are retained.
vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/viewer-context', () => ({
  resolveConciergeViewer: transport.resolve,
  conciergeErrorResponse: (error: unknown, status = 500) =>
    new Response(JSON.stringify({ ok: false, error: String(error) }), { status }),
}));
const f = useOnboardingAuthorityFixture();
let route: typeof import('../src/app/api/onboarding-authority/route');
let decisions: typeof import('../src/app/api/approvals/[id]/route');
let viewer: ConciergeViewerContext;
beforeAll(async () => {
  route = await import('../src/app/api/onboarding-authority/route');
  decisions = await import('../src/app/api/approvals/[id]/route');
}, 60000);
beforeEach(() => {
  viewer = { ...f.viewer.scope, principal: f.viewer.principal };
  transport.resolve.mockImplementation(() => ({ context: viewer }));
});
const request = (body: unknown) =>
  new NextRequest('http://localhost:3050/api/onboarding-authority', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
async function posted(body: unknown) {
  const response = await route.POST(request(body));
  return { response, body: await response.json() };
}
async function create() {
  const input = f.input();
  const preview = await posted({ ...input, action: 'preview' });
  expect(preview.response.status).toBe(200);
  const result = await posted({
    ...input,
    action: 'request',
    digest: preview.body.digest,
    base_hash: preview.body.base_hash,
  });
  expect(result.response.status).toBe(200);
  return result.body.request_id as string;
}
describe('onboarding authority HTTP owner contract with actual stores', () => {
  it('keeps SOD enabled: the installed agent requests and the authenticated human decides', async () => {
    const policyPath = path.join(f.root, 'knowledge/product/governance/approval-policy.json');
    const original = String(safeReadFile(policyPath));
    f.run(() =>
      safeWriteFile(
        policyPath,
        JSON.stringify({ ...JSON.parse(original), separation_of_duties: { enabled: true } })
      )
    );
    try {
      const id = await create();
      const record = f.run(() => f.approvals.loadApprovalRequest('onboarding-authority', id)!);
      expect(record.requestedBy).toBe(f.installedId);
      expect(JSON.parse(record.sourceText!).initiated_by).toBe(viewer.principal!.actor.id);
      const status = await posted({ action: 'status', scope_kind: 'person', request_id: id });
      const decided = await decisions.POST(
        request({
          decision: 'approved',
          channel: 'onboarding-authority',
          storageChannel: 'onboarding-authority',
          presentedDigest: status.body.presented_digest,
        }),
        { params: Promise.resolve({ id }) }
      );
      expect(await decided.json()).toMatchObject({ ok: true });
      expect(
        (await posted({ action: 'apply', scope_kind: 'person', request_id: id })).body.ok
      ).toBe(true);
      expect(
        (
          await posted({
            ...f.input(),
            action: 'request',
            requesterId: 'forged-agent',
            digest: 'fake',
            base_hash: 'fake',
          })
        ).response.status
      ).toBe(400);
    } finally {
      f.run(() => safeWriteFile(policyPath, original));
    }
  });
  it('lets the signed-in personal owner review and decide directly, then apply exactly once', async () => {
    const id = await create();
    const before = await posted({ action: 'apply', scope_kind: 'person', request_id: id });
    expect(before.response.status).not.toBe(200);
    const status = await posted({ action: 'status', scope_kind: 'person', request_id: id });
    expect(status.body).toMatchObject({
      status: 'pending',
      can_apply: false,
      approval_channel: 'onboarding-authority',
    });
    expect(status.body.statement).toContain('https://github.com/fixture/repo');
    const decided = await decisions.POST(
      request({
        decision: 'approved',
        channel: 'onboarding-authority',
        storageChannel: 'onboarding-authority',
        presentedDigest: status.body.presented_digest,
      }),
      { params: Promise.resolve({ id }) }
    );
    expect(await decided.json()).toMatchObject({ ok: true });
    const applied = await posted({ action: 'apply', scope_kind: 'person', request_id: id });
    expect(applied.body.ok).toBe(true);
    const repeat = await posted({ action: 'apply', scope_kind: 'person', request_id: id });
    expect(repeat.response.status).not.toBe(200);
    const current = await route.GET(
      new NextRequest('http://localhost:3050/api/onboarding-authority?scope_kind=person')
    );
    expect(await current.json()).toMatchObject({
      ok: true,
      accountable: { id: 'user:owner' },
      charter: { id: applied.body.charter_id },
    });
  });
  it('discovers the same CLI request on fresh GET and never crosses the selected scope', async () => {
    const cli = f.request();
    const current = await route.GET(
      new NextRequest('http://localhost:3050/api/onboarding-authority?scope_kind=person')
    );
    expect(
      (await current.json()).pending_requests.map((item: { request_id: string }) => item.request_id)
    ).toContain(cli.request_id);
    expect(
      (
        await posted({
          action: 'status',
          scope_kind: 'organization',
          tenant_slug: 'fixture-a',
          request_id: cli.request_id,
        })
      ).response.status
    ).not.toBe(200);
    expect(
      (
        await route.GET(
          new NextRequest(
            'http://localhost:3050/api/onboarding-authority?scope_kind=person&tenant_slug=fixture-a'
          )
        )
      ).status
    ).not.toBe(200);
  });
  it('denies readonly and unrelated tenant viewers and unknown approval fields', async () => {
    viewer = { ...viewer, role: 'readonly' };
    expect((await posted({ ...f.input(), action: 'preview' })).response.status).toBe(403);
    viewer = { ...viewer, role: 'localadmin', tenantSlugs: ['unrelated'] };
    expect(
      (
        await posted({
          ...f.input(),
          scope_kind: 'organization',
          tenant_slug: 'fixture-a',
          action: 'preview',
        })
      ).response.status
    ).toBe(403);
    expect(
      (await posted({ ...f.input(), action: 'request', approved: true })).response.status
    ).toBe(400);
  });
  it('rechecks real membership suspension rather than trusting a retained viewer context', async () => {
    const id = await create();
    f.run(() => {
      const owner = f.members.readMemberProfile('owner')!;
      f.members.writeMemberProfile({ ...owner, status: 'suspended' });
    });
    expect(
      (await posted({ action: 'status', scope_kind: 'person', request_id: id })).response.status
    ).toBe(403);
    expect(
      (
        await route.GET(
          new NextRequest('http://localhost:3050/api/onboarding-authority?scope_kind=person')
        )
      ).status
    ).toBe(403);
  });
});
