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
import { decideApprovalFromCowork } from './approval-cowork-adapter.js';
import { enforceApprovalGate } from './approval-gate.js';
import { createApprovalStorePromptPort } from '../agent/agent-prompt-approval.js';
import { resolveActivationStatus } from '../plugin/plugin-activation-status.js';
import { clearSessionApprovalCache } from './approval-store.js';
import {
  APPROVAL_PLACEHOLDER_DECIDERS,
  evaluateApprovalUsability,
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
        rerequestCommand: 'pnpm demo --request-approval',
      })
    ).toThrow(
      /Separation of duties: approval .* cannot be used .*never reused — request a new approval with `pnpm demo --request-approval`.*pnpm kyberion approvals --approve <new-request-id>/
    );
    expect(loadApprovalRequest(channel, record.id)?.applyClaim).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'separation_of_duties',
        metadata: expect.objectContaining({ stage: 'use:apply_claim' }),
      })
    );
  });

  it('ON: placeholder deciders count as no decider', () => {
    setSeparationOfDuties(true);
    for (const placeholder of [
      'concierge',
      'chronos-localadmin',
      'sovereign-user',
      'user:unknown',
    ]) {
      const record = track(request({ requestedBy: 'worker' }));
      expect(() => decide(record, placeholder)).toThrow(/no real decider identity/);
    }
    expect(APPROVAL_PLACEHOLDER_DECIDERS.has('concierge')).toBe(true);
  });

  it('ON: a caller-supplied decider (MCP kyberion.approval.decide) is refused; OFF it passes', () => {
    setSeparationOfDuties(true);
    const refused = track(request({ requestedBy: 'worker' }));
    expect(() =>
      decideApprovalFromCowork({ requestId: refused.id, decision: 'approved', decidedBy: 'alice' })
    ).toThrow(/supplied by the caller, not resolved by the server/);
    expect(loadApprovalRequest(channel, refused.id)?.status).toBe('pending');

    setSeparationOfDuties(false);
    const allowed = track(request({ requestedBy: 'worker' }));
    expect(
      decideApprovalFromCowork({ requestId: allowed.id, decision: 'approved', decidedBy: 'alice' })
        .decision
    ).toBe('approved');
    // The marker is durable: switching ON later makes the approval unusable.
    const stored = loadApprovalRequest(channel, allowed.id)!;
    expect(stored.decidedByIdentitySource).toBe('caller_supplied');
    setSeparationOfDuties(true);
    expect(evaluateApprovalUsability(stored)?.violation).toBe('unverified_decider');
  });

  it('ON: enforceApprovalGate refuses a self-approval (no expiry) recorded while OFF and opens a fresh request', () => {
    setSeparationOfDuties(false);
    const gate = () =>
      enforceApprovalGate({
        intentId: 'inspect-service',
        operationId: 'inspect-service',
        agentId: 'alice',
        correlationId: `sod-gate-${process.pid}`,
        channel,
        payload: { operation: 'restart', service: 'sod-probe' },
      });
    const first = gate();
    expect(first.allowed).toBe(false);
    const opened = loadApprovalRequest(channel, first.requestId!)!;
    created.push(opened.id);
    expect(opened.expiresAt).toBeUndefined();
    expect(decide(opened, 'alice').status).toBe('approved');
    expect(gate()).toMatchObject({ allowed: true, requestId: opened.id });

    setSeparationOfDuties(true);
    const refused = gate();
    expect(refused.allowed).toBe(false);
    expect(refused.requestId).not.toBe(opened.id);
    created.push(refused.requestId!);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'separation_of_duties',
        result: 'denied',
        metadata: expect.objectContaining({
          requestId: opened.id,
          violation: 'self_approval',
          stage: 'use:approval_gate',
        }),
      })
    );
  });

  it('fails closed with a diagnostic when approval-policy.json is unreadable', () => {
    safeWriteFile(overlayPath, '{ not json');
    sod.overlayPath = overlayPath;
    expect(() => resolveSeparationOfDutiesPolicy()).toThrow(
      /\[POLICY_VIOLATION\] approval decision blocked — approval-policy\.json unreadable \| next: fix .* \| evidence: /
    );
  });

  it('ON: the approval gate re-checks the decision that seeded a session cache grant', () => {
    const payload = { operation: 'restart', service: 'sod-cache' };
    const descriptor = { action: 'inspect-service', targetClass: 'service:sod-cache' };
    try {
      setSeparationOfDuties(false);
      const seed = track(
        createApprovalRequest('mission_controller', {
          channel,
          threadTs: '1',
          correlationId: `sod-cache-seed-${process.pid}`,
          requestedBy: 'alice',
          draft: { title: 'seed', summary: 'session cache seed' },
          accountability: {
            finalDecision: 'human_only',
            payloadHash: computeApprovalPayloadHash(payload),
            effectBinding: 'inspect-service',
          },
        })
      );
      decideApprovalRequest('mission_controller', {
        channel,
        requestId: seed.id,
        decision: 'approved',
        decidedBy: 'alice',
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'manual',
        payloadHash: computeApprovalPayloadHash(payload),
        effectBinding: 'inspect-service',
        sessionCache: descriptor,
      });
      const gate = (correlationId: string) =>
        enforceApprovalGate({
          intentId: 'inspect-service',
          operationId: 'inspect-service',
          agentId: 'alice',
          correlationId,
          channel,
          payload,
          actionDescriptor: descriptor,
        });
      expect(gate(`sod-cache-a-${process.pid}`)).toMatchObject({
        allowed: true,
        requestId: seed.id,
      });

      setSeparationOfDuties(true);
      const refused = gate(`sod-cache-b-${process.pid}`);
      expect(refused.allowed).toBe(false);
      created.push(refused.requestId!);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'separation_of_duties',
          metadata: expect.objectContaining({ stage: 'use:approval_gate_session_cache' }),
        })
      );
    } finally {
      clearSessionApprovalCache();
    }
  });

  it('ON: the approval gate audits a stale unusable approval once, not on every call', () => {
    setSeparationOfDuties(false);
    const gate = () =>
      enforceApprovalGate({
        intentId: 'inspect-service',
        operationId: 'inspect-service',
        agentId: 'alice',
        correlationId: `sod-gate-once-${process.pid}`,
        channel,
        payload: { operation: 'restart', service: 'sod-once' },
      });
    const opened = loadApprovalRequest(channel, gate().requestId!)!;
    created.push(opened.id);
    decide(opened, 'alice');
    setSeparationOfDuties(true);
    const sodAudits = () =>
      audit.mock.calls.filter(
        ([entry]) => (entry as { operation?: string }).operation === 'separation_of_duties'
      ).length;
    const replacement = gate();
    created.push(replacement.requestId!);
    expect(sodAudits()).toBe(1);
    expect(gate().requestId).toBe(replacement.requestId);
    expect(gate().requestId).toBe(replacement.requestId);
    expect(sodAudits()).toBe(1);
  });

  it('ON: the approval gate does not re-audit a stale unusable approval while a usable candidate exists', () => {
    const correlationId = `sod-gate-stale-${process.pid}`;
    const payload = { operation: 'restart', service: 'sod-stale' };
    const open = (title: string) =>
      track(
        createApprovalRequest('mission_controller', {
          channel,
          threadTs: title,
          correlationId,
          requestedBy: 'alice',
          draft: { title, summary: 'gate candidate' },
        })
      );
    setSeparationOfDuties(false);
    const pending = open('older-pending');
    // The gate scans newest first: make sure the stale approval is newer.
    const later = Date.now() + 5;
    while (Date.now() < later) {
      /* wait for the next millisecond tick */
    }
    const stale = open('newer-self-approved');
    decide(stale, 'alice');
    setSeparationOfDuties(true);
    const gate = () =>
      enforceApprovalGate({
        intentId: 'inspect-service',
        operationId: 'inspect-service',
        agentId: 'alice',
        correlationId,
        channel,
        payload,
      });
    for (let i = 0; i < 3; i += 1) {
      expect(gate()).toMatchObject({ allowed: false, requestId: pending.id });
    }
    expect(
      audit.mock.calls.filter(
        ([entry]) => (entry as { operation?: string }).operation === 'separation_of_duties'
      )
    ).toHaveLength(0);
  });

  it('ON: the agent prompt port opens a new request instead of reusing an unusable self-approval', () => {
    const port = createApprovalStorePromptPort();
    const request = {
      agentName: `sod-agent-${process.pid}`,
      provider: 'test',
      signatureId: 'workspace_trust',
      cwd: '/tmp',
      excerpt: 'trust this folder?',
    };
    setSeparationOfDuties(false);
    const first = port.open(request);
    const record = loadApprovalRequest('agent-runtime', first.id)!;
    decideApprovalRequest('mission_controller', {
      channel: record.channel,
      requestId: record.id,
      decision: 'approved',
      decidedBy: request.agentName,
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'manual',
      payloadHash: record.accountability?.payloadHash,
      effectBinding: record.accountability?.effectBinding,
    });
    expect(port.open(request)).toEqual({ id: first.id, created: false });
    setSeparationOfDuties(true);
    expect(port.status(first.id)).toBe('closed');
    const second = port.open(request);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    withExecutionContext('mission_controller', () => {
      for (const id of [first.id, second.id]) {
        safeRmSync(pathResolver.rootResolve(approvalRequestLogicalPath('agent-runtime', id)), {
          force: true,
        });
      }
    });
  });

  it('plugin activation degrades to pending (no throw) when SoD refuses or the policy is unreadable', () => {
    const base = { diagnostics: [], trust: 'third-party' as const, integrity: 'verified' as const };
    const approved = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      status: 'approved',
      requestedBy: 'alice',
      decidedBy: 'alice',
      correlationId: 'c',
      channel: 'plugin',
    } as ApprovalRequestRecord;
    setSeparationOfDuties(false);
    expect(resolveActivationStatus({ ...base, approval: approved })).toBe('activatable');
    setSeparationOfDuties(true);
    expect(resolveActivationStatus({ ...base, approval: approved })).toBe('pending_approval');
    safeWriteFile(overlayPath, '{ not json');
    expect(() => resolveActivationStatus({ ...base, approval: approved })).not.toThrow();
    expect(resolveActivationStatus({ ...base, approval: approved })).toBe('pending_approval');
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
