import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owner = vi.hoisted(() => ({ present: true }));
vi.mock('../organization/member-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../organization/member-registry.js')>();
  return {
    ...actual,
    resolveMemberByPrincipal: (input: { source: string }) =>
      input.source === 'loopback' && owner.present
        ? { member_id: 'owner', display_name: 'Alice Example', status: 'active' }
        : null,
  };
});
vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  const { customerRootWithSodOverlay } = await import('./__tests__/sod-overlay-state.js');
  return { ...actual, customerRoot: customerRootWithSodOverlay(actual.customerRoot) };
});

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync } from '../secure-io.js';
import { auditChain } from './audit-chain.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  approvalUsabilityRefusal,
  assertApprovalUsable,
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  decideApprovalRequest,
  evaluateApprovalUsability,
  loadApprovalRequest,
  lookupSessionApprovalCache,
  clearSessionApprovalCache,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  markApprovalConsumed,
  revokeApprovalAsLocalOwner,
  revokeApprovalRequest,
} from './approval-revocation.js';
import {
  clearSeparationOfDuties,
  setSeparationOfDuties,
  useSeparationOfDutiesOverlay,
} from './__tests__/sod-overlay.js';

const channel = `revoke-test-${process.pid}`;
const role = 'mission_controller' as const;

function openRequest(requestedBy = 'agent:planner'): ApprovalRequestRecord {
  const payloadHash = computeApprovalPayloadHash({ op: 'revoke-probe' });
  return createApprovalRequest(role, {
    channel,
    threadTs: '1',
    correlationId: `revoke-${Math.random()}`,
    requestedBy,
    kind: 'mission_gate',
    draft: { title: 'revoke probe', summary: 'approval revocation test' },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding: 'revoke:probe' },
  });
}

function approve(
  record: ApprovalRequestRecord,
  decidedBy = 'user:alice',
  extra: Partial<Parameters<typeof decideApprovalRequest>[1]> = {}
): ApprovalRequestRecord {
  return decideApprovalRequest(role, {
    channel: record.channel,
    requestId: record.id,
    decision: 'approved',
    decidedBy,
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
    ...extra,
  });
}

function revoke(
  record: ApprovalRequestRecord,
  revokedBy: string,
  extra: Partial<Parameters<typeof revokeApprovalRequest>[1]> = {}
): ApprovalRequestRecord {
  return revokeApprovalRequest(role, {
    channel: record.channel,
    requestId: record.id,
    revokedBy,
    reason: 'stale approval',
    ...extra,
  });
}

function events(): Array<Record<string, unknown>> {
  const raw = safeReadFile(pathResolver.rootResolve(approvalEventLogicalPath(channel)), {
    encoding: 'utf8',
  }) as string;
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('revoking an approved approval (further uses refused)', () => {
  let audit: ReturnType<typeof vi.spyOn>;
  const created: string[] = [];
  const overlayDir = pathResolver.sharedTmp(`approval-revocation-${process.pid}`);

  beforeEach(() => {
    useSeparationOfDutiesOverlay(path.join(overlayDir, `overlay-${Math.random()}.json`));
    audit = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    audit.mockRestore();
    clearSeparationOfDuties();
    clearSessionApprovalCache();
    for (const id of created.splice(0)) {
      safeRmSync(pathResolver.rootResolve(approvalRequestLogicalPath(channel, id)), {
        force: true,
      });
    }
    safeRmSync(pathResolver.rootResolve(approvalEventLogicalPath(channel)), { force: true });
    safeRmSync(overlayDir, { recursive: true, force: true });
  });

  const track = (record: ApprovalRequestRecord) => {
    created.push(record.id);
    return record;
  };

  it('makes the record unusable for every consumer, with separation of duties off', () => {
    const approved = approve(track(openRequest()));
    expect(evaluateApprovalUsability(approved)).toBeNull();

    const revoked = revoke(approved, 'user:alice');
    expect(revoked.status).toBe('approved');
    expect(revoked.revocation).toMatchObject({ revokedBy: 'user:alice', reason: 'stale approval' });
    expect(loadApprovalRequest(channel, approved.id)?.revocation?.revokedBy).toBe('user:alice');

    expect(evaluateApprovalUsability(revoked, { consumer: 'approval_gate' })).toEqual({
      violation: 'revoked',
      decidedBy: 'user:alice',
    });
    expect(() => assertApprovalUsable(revoked, { consumer: 'project_trust' })).toThrow(
      /\[POLICY_VIOLATION\] Approval .* cannot be used because it was revoked by user:alice .*\(stale approval\)/
    );
    expect(approvalUsabilityRefusal(revoked, 'dot_release')).toMatch(/was revoked/);
    expect(() =>
      claimApprovalApply(role, {
        channel,
        requestId: revoked.id,
        appliedBy: 'operator',
        expectedRecordHash: computeApprovalPayloadHash({ record: revoked }),
      })
    ).toThrow(/was revoked/);
    expect(loadApprovalRequest(channel, revoked.id)?.applyClaim).toBeUndefined();
  });

  it('is audited to the event log and the audit chain', () => {
    const approved = approve(track(openRequest()));
    revoke(approved, 'agent:planner');
    expect(events().find((event) => event.event === 'revoked')).toMatchObject({
      request_id: approved.id,
      revoked_by: 'agent:planner',
      revoker_authority: 'accountable_principal',
      reason: 'stale approval',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval_decision',
        operation: 'revoke',
        result: 'completed',
        metadata: expect.objectContaining({ requestId: approved.id, decidedBy: 'user:alice' }),
      })
    );
  });

  it('may be done by the requester, an approver or the local owner — nobody else', () => {
    const byRequester = approve(track(openRequest('agent:planner')));
    expect(revoke(byRequester, 'agent:planner').revocation).toBeDefined();

    const byOwner = approve(track(openRequest('agent:planner')));
    expect(() => revoke(byOwner, 'user:mallory')).toThrow(
      /cannot be revoked: user:mallory is neither its requester, one of its approvers, nor the local owner/
    );
    expect(() => revoke(byOwner, 'sovereign-user')).toThrow(/empty or a surface placeholder/);
    // Claiming to be the owner proves nothing: owner authority is resolved server-side.
    expect(() => revoke(byOwner, 'user:owner')).toThrow(/neither its requester/);
    const asOwner = revokeApprovalAsLocalOwner(role, { channel, requestId: byOwner.id });
    expect(asOwner.revocation).toMatchObject({
      revokedBy: 'user:owner',
      revokedByDisplayName: 'Alice Example',
    });
    expect(
      events().find((e) => e.event === 'revoked' && e.request_id === byOwner.id)
    ).toMatchObject({ revoker_authority: 'owner' });

    owner.present = false;
    try {
      const noOwner = approve(track(openRequest('agent:planner')));
      expect(() => revokeApprovalAsLocalOwner(role, { channel, requestId: noOwner.id })).toThrow(
        /no active owner member/
      );
    } finally {
      owner.present = true;
    }
  });

  it('a one-shot consumption is recorded once, and a later revoke reports it consumed', () => {
    const approved = approve(track(openRequest()));
    const consume = () =>
      markApprovalConsumed(role, {
        channel,
        requestId: approved.id,
        consumer: 'organization_decision',
        consumedBy: 'organization-cli',
      });
    expect(consume().consumption).toMatchObject({ consumer: 'organization_decision' });
    expect(() => consume()).toThrow(/was already used by organization_decision/);
    expect(() => revoke(approved, 'user:alice')).toThrow(
      /already consumed by organization_decision .* one-shot effect has happened/
    );
    expect(events().find((e) => e.event === 'consumed')).toMatchObject({
      request_id: approved.id,
      consumer: 'organization_decision',
    });

    const revoked = approve(track(openRequest()));
    revoke(revoked, 'user:alice');
    expect(() =>
      markApprovalConsumed(role, {
        channel,
        requestId: revoked.id,
        consumer: 'organization_decision',
        consumedBy: 'organization-cli',
      })
    ).toThrow(/was revoked/);
  });

  it('refuses pending, claimed, already revoked and rejected records', () => {
    const pending = track(openRequest());
    expect(() => revoke(pending, 'agent:planner')).toThrow(/still pending — cancel it instead/);

    const claimed = approve(track(openRequest()));
    claimApprovalApply(role, {
      channel,
      requestId: claimed.id,
      appliedBy: 'operator',
      expectedRecordHash: computeApprovalPayloadHash({ record: claimed }),
    });
    expect(() => revoke(claimed, 'user:alice')).toThrow(/already claimed or applied/);

    const twice = approve(track(openRequest()));
    revoke(twice, 'user:alice');
    expect(() => revoke(twice, 'user:alice')).toThrow(/already revoked by user:alice/);

    const rejected = track(openRequest());
    decideApprovalRequest(role, {
      channel,
      requestId: rejected.id,
      decision: 'rejected',
      decidedBy: 'user:alice',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: rejected.accountability?.payloadHash,
      effectBinding: rejected.accountability?.effectBinding,
    });
    expect(() => revoke(rejected, 'user:alice')).toThrow(/it is rejected, not approved/);
  });

  it('drops a session-cache grant it seeded', () => {
    const request = track(openRequest('agent:worker'));
    const descriptor = { action: 'revoke:probe', targetClass: 'probe' };
    const approved = approve(request, 'user:alice', { sessionCache: descriptor });
    const lookup = () =>
      lookupSessionApprovalCache(descriptor, Date.now(), {
        agentId: 'agent:worker',
        payloadHash: approved.accountability!.payloadHash!,
        effectBinding: approved.accountability!.effectBinding!,
      });
    expect(lookup()?.grantedByRequestId).toBe(approved.id);
    revoke(approved, 'user:alice');
    expect(lookup()).toBeNull();
  });

  it('a separation-of-duties refusal offers revoke for an approved, unused record', () => {
    const self = approve(track(openRequest('user:alice')));
    setSeparationOfDuties(true);
    expect(() => assertApprovalUsable(self, { consumer: 'approval_gate' })).toThrow(
      new RegExp(
        `revoke it \\(further uses refused\\), run \`pnpm kyberion approvals --revoke ${self.id}\``
      )
    );
  });
});
