import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({
  source: 'header',
  deny: false,
  auth: vi.fn(),
  context: 'context-a',
  participants: vi.fn(),
  candidates: vi.fn(),
  roles: vi.fn(),
  assign: vi.fn(),
  remove: vi.fn(),
  agents: vi.fn(),
  showAgent: vi.fn(),
  issue: vi.fn(),
  lifecycle: vi.fn(),
  accountable: vi.fn(),
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: () =>
    mocks.deny ? NextResponse.json({ ok: false }, { status: 403 }) : null,
}));
vi.mock('../../../../lib/viewer-context', () => ({
  conciergeCredential: () => ({ source: mocks.source, token: 'synthetic-owner' }),
  guardConciergeRequest: () => null,
}));
vi.mock('../../../../lib/management-server', () => ({
  managementAuthorization: mocks.auth,
  managementContextId: () => mocks.context,
}));
vi.mock('@agent/core/organization/organization-participants', () => ({
  listOrganizationParticipants: mocks.participants,
  listOrganizationParticipantCandidates: mocks.candidates,
  listOrganizationBusinessRoles: mocks.roles,
  setOrganizationParticipant: mocks.assign,
  removeOrganizationParticipant: mocks.remove,
}));
vi.mock('@agent/core/organization/organization-agent-management', () => ({
  listManagedOrganizationAgents: mocks.agents,
  showManagedOrganizationAgent: mocks.showAgent,
  issueManagedOrganizationAgent: mocks.issue,
  changeManagedOrganizationAgentLifecycle: mocks.lifecycle,
  reassignManagedOrganizationAgentAccountable: mocks.accountable,
}));
vi.mock('@agent/core/surface/surface-management-mutations', () => ({
  SurfaceManagementError: class extends Error {
    constructor(
      public code: string,
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
import { GET, POST } from './route';
const authorization = {
  actorId: 'user:owner',
  memberId: 'owner',
  tenantSlug: 'alpha',
  allowedOrganizationIds: 'all',
  allowedProjectIds: 'all',
};
const base = { tenant: 'alpha', organizationId: 'org-a', contextId: 'context-a' };
const request = (command: unknown, origin = 'http://localhost') =>
  new NextRequest('http://localhost/api/management/participants', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, host: 'localhost' },
    body: JSON.stringify(command),
  });
beforeEach(() => {
  mocks.source = 'header';
  mocks.deny = false;
  mocks.context = 'context-a';
  for (const fn of [mocks.participants, mocks.candidates, mocks.agents])
    fn.mockReset().mockResolvedValue([]);
  mocks.roles.mockReset().mockReturnValue([]);
  for (const fn of [mocks.assign, mocks.remove, mocks.issue, mocks.lifecycle, mocks.accountable])
    fn.mockReset().mockResolvedValue({ private_field: 'not-a-public-result' });
  mocks.auth.mockReset().mockReturnValue(authorization);
  mocks.showAgent.mockReset().mockResolvedValue({ home_organization_id: 'org-a' });
});
describe('organization participants HTTP scope boundary', () => {
  it('lists using server-derived authority and an explicit selected organization', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/management/participants?tenant=alpha&organization_id=org-a'
      )
    );
    expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), 'alpha');
    expect(mocks.participants).toHaveBeenCalledWith(authorization, 'org-a');
    expect(await response.json()).toMatchObject({
      contextId: 'context-a',
      actorId: 'user:owner',
      tenant: 'alpha',
      organizationId: 'org-a',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    'tenant=alpha&tenant=beta&organization_id=org-a',
    'tenant=alpha&organization_id=org-a&role=owner',
    'tenant=alpha',
  ])('rejects invalid narrowing %s', async (query) => {
    expect(
      (await GET(new NextRequest('http://localhost/api/management/participants?' + query))).status
    ).toBe(400);
    expect(mocks.participants).not.toHaveBeenCalled();
  });
  it('does not turn a client tenant into authorization', async () => {
    mocks.auth.mockImplementation(() => {
      throw new SurfaceManagementError('forbidden', 403, 'Not an owner');
    });
    expect(
      (
        await GET(
          new NextRequest(
            'http://localhost/api/management/participants?tenant=beta&organization_id=org-b'
          )
        )
      ).status
    ).toBe(403);
    expect(mocks.candidates).not.toHaveBeenCalled();
  });
  it('rejects changed owner context before mutation', async () => {
    expect(
      (
        await POST(
          request({
            ...base,
            contextId: 'other',
            operation: 'participant.assign',
            actor: 'user:alice',
            roleIds: [],
          })
        )
      ).status
    ).toBe(403);
    expect(mocks.assign).not.toHaveBeenCalled();
  });
  it.each(['session-cookie', 'none'])('requires same-origin for %s', async (source) => {
    mocks.source = source;
    expect(
      (
        await POST(
          request(
            {
              ...base,
              operation: 'participant.remove',
              actor: 'user:alice',
              expectedVersion: 'v1',
            },
            'https://attacker.invalid'
          )
        )
      ).status
    ).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('preserves plural responsibility roles and expected revision without returning internal state', async () => {
    const response = await POST(
      request({
        ...base,
        operation: 'participant.assign',
        actor: 'user:alice',
        roleIds: ['planner', 'reviewer'],
        expectedVersion: 'v1',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.assign).toHaveBeenCalledWith(authorization, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['planner', 'reviewer'],
      expectedVersion: 'v1',
    });
    expect(await response.json()).toEqual({ ok: true, operation: 'participant.assign' });
  });
  it('rejects fields for a different operation and missing removal revision', async () => {
    expect(
      (
        await POST(
          request({
            ...base,
            operation: 'participant.remove',
            actor: 'user:alice',
            expectedVersion: 'v1',
            roleIds: ['owner'],
          })
        )
      ).status
    ).toBe(400);
    expect(
      (await POST(request({ ...base, operation: 'participant.remove', actor: 'user:alice' })))
        .status
    ).toBe(400);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('cannot apply an agent lifecycle change through a different selected organization', async () => {
    mocks.showAgent.mockResolvedValue({ home_organization_id: 'org-b' });
    expect(
      (
        await POST(
          request({
            ...base,
            operation: 'agent.lifecycle',
            nhiId: 'kyberion://agent/org-b/a',
            action: 'retire',
            reason: 'test',
            expectedVersion: 'v1',
          })
        )
      ).status
    ).toBe(404);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
  it('propagates guarded lifecycle arguments and fails closed on unknown backend errors', async () => {
    const command = {
      ...base,
      operation: 'agent.lifecycle',
      nhiId: 'kyberion://agent/org-a/a',
      action: 'suspend',
      reason: 'test',
      expectedVersion: 'v1',
    };
    expect((await POST(request(command))).status).toBe(200);
    expect(mocks.lifecycle).toHaveBeenCalledWith(authorization, {
      nhiId: command.nhiId,
      action: 'suspend',
      reason: 'test',
      expectedVersion: 'v1',
    });
    mocks.lifecycle.mockRejectedValue(new Error('/private/hidden-state'));
    const failed = await POST(request(command));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('hidden-state');
  });
  it('honors mutation guard denial without resolving owner authority', async () => {
    mocks.deny = true;
    expect((await POST(request({ ...base, operation: 'agent.issue' }))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
