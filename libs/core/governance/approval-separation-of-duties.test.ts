import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Separation of duties is driven by the real `approval-policy.json` loader:
 * switching it on writes a customer overlay of the product policy with
 * `separation_of_duties.enabled: true` and points `customerRoot` at it, the
 * same way an operator would enable it for a customer installation.
 */
const sod = vi.hoisted(() => ({ overlayPath: null as string | null }));

vi.mock('../customer-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-resolver.js')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { auditChain } from './audit-chain.js';
import { resolveSeparationOfDutiesPolicy } from './approval-policy.js';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  decideApprovalRequest,
  evaluateSeparationOfDuties,
  loadApprovalRequest,
  normalizeApprovalPrincipalId,
  type ApprovalRequestRecord,
} from './approval-store.js';

const channel = `sod-test-${process.pid}`;
const overlayPath = pathResolver.sharedTmp(`approval-sod-overlay-${process.pid}.json`);

function setSeparationOfDuties(enabled: boolean): void {
  const product = JSON.parse(
    safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
      encoding: 'utf8',
    }) as string
  );
  safeWriteFile(
    overlayPath,
    JSON.stringify({ ...product, separation_of_duties: { enabled } }, null, 2)
  );
  sod.overlayPath = overlayPath;
}

function request(overrides: {
  requestedBy: string;
  actorId?: string;
  agentId?: string;
}): ApprovalRequestRecord {
  const payloadHash = computeApprovalPayloadHash({ op: 'sod-probe' });
  return createApprovalRequest('mission_controller', {
    channel,
    threadTs: '1',
    correlationId: `sod-${Math.random()}`,
    requestedBy: overrides.requestedBy,
    kind: 'mission_gate',
    draft: { title: 'sod probe', summary: 'separation-of-duties test' },
    ...(overrides.actorId
      ? {
          requestedByContext: {
            surface: 'terminal' as const,
            actorId: overrides.actorId,
            actorRole: 'tester',
          },
        }
      : {}),
    ...(overrides.agentId ? { source: { agentId: overrides.agentId } } : {}),
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding: 'sod:probe' },
  });
}

function decide(
  record: ApprovalRequestRecord,
  decidedBy: string,
  decision: 'approved' | 'rejected' = 'approved'
): ApprovalRequestRecord {
  return decideApprovalRequest('mission_controller', {
    channel: record.channel,
    requestId: record.id,
    decision,
    decidedBy,
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
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

describe('approval separation of duties', () => {
  let audit: ReturnType<typeof vi.spyOn>;
  const created: string[] = [];

  beforeEach(() => {
    audit = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    audit.mockRestore();
    sod.overlayPath = null;
    withExecutionContext('mission_controller', () => {
      for (const id of created.splice(0)) {
        safeRmSync(pathResolver.rootResolve(approvalRequestLogicalPath(channel, id)), {
          force: true,
        });
      }
      safeRmSync(pathResolver.rootResolve(approvalEventLogicalPath(channel)), { force: true });
    });
    safeRmSync(overlayPath, { force: true });
  });

  function track(record: ApprovalRequestRecord): ApprovalRequestRecord {
    created.push(record.id);
    return record;
  }

  it('is off by default in the product approval policy', () => {
    expect(resolveSeparationOfDutiesPolicy()).toEqual({ enabled: false });
  });

  it('OFF: a requester may approve their own request (unchanged behaviour)', () => {
    setSeparationOfDuties(false);
    const record = track(request({ requestedBy: 'alice' }));
    expect(decide(record, 'alice').status).toBe('approved');
  });

  it('ON: self-approval is refused, audited, and the request stays pending', () => {
    setSeparationOfDuties(true);
    expect(resolveSeparationOfDutiesPolicy()).toEqual({ enabled: true });
    const record = track(request({ requestedBy: 'alice' }));

    expect(() => decide(record, 'alice')).toThrow(
      /\[POLICY_VIOLATION\] Separation of duties: .*same principal/
    );
    expect(loadApprovalRequest(channel, record.id)?.status).toBe('pending');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval_decision',
        operation: 'separation_of_duties',
        result: 'denied',
        metadata: expect.objectContaining({
          requestId: record.id,
          violation: 'self_approval',
          decidedBy: 'alice',
          stage: 'decide',
        }),
      })
    );
    expect(events()).toContainEqual(
      expect.objectContaining({
        event: 'separation_of_duties_refused',
        request_id: record.id,
        violation: 'self_approval',
      })
    );
  });

  it('ON: identities are compared after normalisation and across every requester field', () => {
    setSeparationOfDuties(true);
    const prefixed = track(request({ requestedBy: 'user:Alice ' }));
    expect(() => decide(prefixed, 'ALICE')).toThrow(/same principal/);

    const viaContext = track(request({ requestedBy: 'worker', actorId: 'human:bob' }));
    expect(() => decide(viaContext, 'user:bob')).toThrow(/same principal/);

    const viaSource = track(request({ requestedBy: 'worker', agentId: 'agent:carol' }));
    expect(() => decide(viaSource, 'carol')).toThrow(/same principal/);
  });

  it('ON: an agent-requested request approved by a different human still passes', () => {
    setSeparationOfDuties(true);
    const record = track(
      request({ requestedBy: 'worker', actorId: 'worker', agentId: 'agent:mission-worker' })
    );
    const decided = decide(record, 'alice');
    expect(decided.status).toBe('approved');
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'separation_of_duties' })
    );
  });

  it('ON: a request with no recorded requester is refused (fail closed)', () => {
    setSeparationOfDuties(true);
    const record = track(request({ requestedBy: '   ' }));
    expect(() => decide(record, 'alice')).toThrow(/records no requester identity/);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ violation: 'missing_requester' }),
      })
    );
  });

  it('ON: a requester may still reject (withdraw) their own request', () => {
    setSeparationOfDuties(true);
    const record = track(request({ requestedBy: 'alice' }));
    expect(decide(record, 'alice', 'rejected').status).toBe('rejected');
  });

  it('ON: a self-approval recorded while OFF cannot be applied after switching ON', () => {
    setSeparationOfDuties(false);
    const record = track(request({ requestedBy: 'alice' }));
    const approved = decide(record, 'alice');
    setSeparationOfDuties(true);
    expect(() =>
      claimApprovalApply('mission_controller', {
        channel,
        requestId: record.id,
        appliedBy: 'alice',
        expectedRecordHash: computeApprovalPayloadHash({ record: approved }),
      })
    ).toThrow(/Separation of duties/);
    expect(loadApprovalRequest(channel, record.id)?.applyClaim).toBeUndefined();
  });

  it('normalises principal ids and classifies violations', () => {
    expect(normalizeApprovalPrincipalId(' User:Ａlice ')).toBe('alice');
    expect(normalizeApprovalPrincipalId(undefined)).toBe('');
    expect(evaluateSeparationOfDuties({ requestedBy: 'worker' }, 'alice')).toBeNull();
    expect(evaluateSeparationOfDuties({ requestedBy: 'alice' }, 'human:alice')).toBe(
      'self_approval'
    );
    expect(evaluateSeparationOfDuties({ requestedBy: '' }, 'alice')).toBe('missing_requester');
    expect(evaluateSeparationOfDuties({ requestedBy: 'worker' }, '')).toBe('missing_decider');
  });
});
