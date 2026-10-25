import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { writeMemberProfile, memberProfilePath } from '../organization/member-registry.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  memoryPromotionQueuePath,
} from './memory-promotion-queue.js';
import {
  requestScopedLearningApproval,
  verifyScopedLearningApprovalRef,
} from './scoped-learning-approval.js';
import {
  loadApprovalRequest,
  decideApprovalRequest,
  computeApprovalPresentedDigest,
  approvalRequestLogicalPath,
  approvalEventLogicalPath,
  approvalStoreRoots,
  cancelApprovalRequest,
} from '../governance/approval-store.js';
const memberId = 'sop-reviewer-' + process.pid;
const refs: string[] = [];
let sequence = 0;
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'synthetic-sop-review-' + process.pid,
  organization_id: 'ORG-SOP',
  project_id: 'PRJ-SOP',
};
function member(
  status: 'active' | 'suspended' = 'active',
  role: 'approver' | 'viewer' = 'approver'
) {
  withExecutionContext('sovereign_concierge', () =>
    writeMemberProfile({
      member_id: memberId,
      display_name: 'Synthetic SOP reviewer',
      status,
      memberships: [{ tenant_slug: scope.tenant_slug, role }],
      access_registrations: [],
      created_at: '2026-10-20T00:00:00.000Z',
      updated_at: '2026-10-20T00:00:00.000Z',
    })
  );
}
function fixture() {
  const candidate = createMemoryPromotionCandidate({
    candidateId: 'MEM-SOP-PROOF-' + process.pid + '-' + ++sequence,
    sourceType: 'task_session',
    sourceRef: 'task_session:synthetic-' + sequence,
    knowledgeDomain: 'organization',
    proposedMemoryKind: 'sop',
    summary: 'Check the exact scoped input before producing the report.',
    evidenceRefs: ['task_session:synthetic'],
    sensitivityTier: 'confidential',
    scope,
    ratificationRequired: true,
  });
  candidate.curation = {
    title: 'Synthetic scoped report SOP',
    summary: candidate.summary,
    content: 'Check the source scope. Produce the report. Verify its evidence.',
    evidence_refs: candidate.evidence_refs,
  };
  enqueueMemoryPromotionCandidate(candidate);
  const request = requestScopedLearningApproval({
    candidate,
    requester: { requestedBy: 'agent:synthetic-planner', actorId: 'agent:synthetic-planner' },
  });
  refs.push(request.ref);
  return { candidate, ...request };
}
function decide(ref: string, options: Partial<Parameters<typeof decideApprovalRequest>[1]> = {}) {
  const [channel, requestId] = ref.split(':');
  const record = loadApprovalRequest(channel!, requestId!)!;
  return decideApprovalRequest('infrastructure_sentinel', {
    channel: channel!,
    requestId: requestId!,
    decision: 'approved',
    decidedBy: 'user:' + memberId,
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    deciderIdentitySource: 'server_resolved',
    presentedDigest: computeApprovalPresentedDigest(record),
    ...options,
  });
}
beforeEach(() => {
  vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
  member();
});
afterEach(() => {
  withExecutionContext('infrastructure_sentinel', () => {
    for (const ref of refs.splice(0)) {
      const [channel, id] = ref.split(':');
      safeRmSync(pathResolver.rootResolve(approvalRequestLogicalPath(channel!, id!)), {
        force: true,
      });
    }
    safeRmSync(pathResolver.rootResolve(approvalEventLogicalPath('terminal')), { force: true });
    // Tenant-scoped requests live in the tenant approval partitions.
    safeRmSync(pathResolver.rootResolve(approvalStoreRoots().tenantApprovals), {
      recursive: true,
      force: true,
    });
  });
  withExecutionContext('sovereign_concierge', () =>
    safeRmSync(memberProfilePath(memberId), { force: true })
  );
  withExecutionContext('ecosystem_architect', () =>
    safeRmSync(memoryPromotionQueuePath(scope), { force: true })
  );
  vi.unstubAllEnvs();
});
describe('scoped SOP authenticated review', () => {
  it('opens once, remains pending, then verifies the exact human-approved content', () => {
    const f = fixture();
    expect(
      requestScopedLearningApproval({ candidate: f.candidate, requester: { requestedBy: 'other' } })
        .ref
    ).toBe(f.ref);
    expect(() => verifyScopedLearningApprovalRef(f.candidate, f.ref)).toThrow(/APPROVAL_REQUIRED/);
    decide(f.ref);
    expect(verifyScopedLearningApprovalRef(f.candidate, f.ref)).toMatchObject({
      approval_ref: f.ref,
      decided_by: { kind: 'human', id: 'user:' + memberId },
    });
  });
  it('rejects different content or scope after approval', () => {
    const f = fixture();
    decide(f.ref);
    expect(() =>
      verifyScopedLearningApprovalRef({ ...f.candidate, summary: 'Changed' }, f.ref)
    ).toThrow(/BINDING/);
    expect(() =>
      verifyScopedLearningApprovalRef(
        { ...f.candidate, scope: { ...scope, project_id: 'PRJ-SIBLING' } },
        f.ref
      )
    ).toThrow(/BINDING/);
  });
  it('does not reopen rejection or cancellation', () => {
    const f = fixture();
    decide(f.ref, { decision: 'rejected' });
    expect(
      requestScopedLearningApproval({
        candidate: f.candidate,
        requester: { requestedBy: 'agent:x' },
      })
    ).toMatchObject({ ref: f.ref, status: 'rejected' });
    expect(() => verifyScopedLearningApprovalRef(f.candidate, f.ref)).toThrow();
    const g = fixture();
    cancelApprovalRequest('infrastructure_sentinel', {
      channel: 'terminal',
      requestId: g.ref.split(':')[1]!,
      cancelledBy: 'test',
      reason: 'test',
    });
    expect(
      requestScopedLearningApproval({
        candidate: g.candidate,
        requester: { requestedBy: 'agent:x' },
      }).status
    ).toBe('cancelled');
  });
  it('does not accept a human label or unpresented decision', () => {
    const f = fixture();
    vi.stubEnv('KYBERION_APPROVAL_ASSURANCE_MODE', 'warn');
    const record = loadApprovalRequest('terminal', f.ref.split(':')[1]!)!;
    decide(f.ref, {
      presentedDigest: undefined,
      payloadHash: record.accountability!.payloadHash,
      effectBinding: record.accountability!.effectBinding,
    });
    expect(() => verifyScopedLearningApprovalRef(f.candidate, f.ref)).toThrow(/APPROVAL_REQUIRED/);
  });
  it('rechecks current reviewing member authority', () => {
    const f = fixture();
    decide(f.ref);
    member('suspended');
    expect(() => verifyScopedLearningApprovalRef(f.candidate, f.ref)).toThrow(/AUTHORITY/);
  });
  it('refuses a still-active reviewer whose membership lost approval authority', () => {
    const f = fixture();
    decide(f.ref);
    member('active', 'viewer');
    expect(() => verifyScopedLearningApprovalRef(f.candidate, f.ref)).toThrow(/AUTHORITY/);
  });
  it('accepts existing real-terminal A2 proof with unmarked server identity', () => {
    const f = fixture();
    decide(f.ref, { authMethod: 'terminal_attested', deciderIdentitySource: undefined });
    expect(verifyScopedLearningApprovalRef(f.candidate, f.ref).approval_ref).toBe(f.ref);
  });
  it('refuses an agent principal on the authenticated human surface', () => {
    const f = fixture();
    expect(() =>
      decide(f.ref, {
        deciderPrincipal: {
          actor: { kind: 'agent', id: 'agent:synthetic-planner' },
          source: 'agent',
          provider: 'agent-token',
          principalId: 'agent:synthetic-planner',
        },
      })
    ).toThrow(/HUMAN_PROOF_REQUIRED/);
  });
});
