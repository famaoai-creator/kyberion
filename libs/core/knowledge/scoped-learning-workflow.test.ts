import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withExecutionContext, withExecutionContextAsync, resolveRole } from '../authority.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import * as secureIo from '../secure-io.js';
import * as textIo from '../foundation/text.js';
import { pathResolver } from '../path-resolver.js';
import { auditChain } from '../governance/audit-chain.js';
import * as approvals from '../governance/approval-store.js';
import { writeMemberProfile, memberProfilePath } from '../organization/member-registry.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  memoryPromotionQueuePath,
  memoryPromotionCandidateKey,
  updateMemoryPromotionCandidateStatus,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import { approvedLearningPayloadDigest } from './scoped-learning-domain.js';
import { requestScopedLearningApproval } from './scoped-learning-approval.js';
import {
  findScopedLearningApprovalRequest,
  verifyScopedLearningApprovalRef,
} from './scoped-learning-approval-verifier.js';
import {
  inspectScopedLearningPublication,
  verifyScopedLearningPublication,
} from './scoped-learning-publication.js';
import * as memoryQueue from './memory-promotion-queue.js';
import {
  curateScopedLearningCandidate,
  inspectScopedLearningCandidate,
  inspectScopedLearningReview,
  requestScopedLearningCandidateApproval,
  publishScopedLearningCandidate,
} from './scoped-learning-workflow.js';

const cleanup = new Set<string>();
const candidates: MemoryCandidate[] = [];
beforeEach(() => {
  vi.stubEnv(
    'KYBERION_MEMORY_QUEUE_PATH',
    'active/shared/tmp/test-scoped-learning-workflow-' + randomUUID() + '.jsonl'
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  withExecutionContext('ecosystem_architect', () => {
    for (const candidate of candidates.splice(0)) {
      const record = findScopedLearningApprovalRequest(candidate);
      if (record)
        safeRmSync(
          pathResolver.rootResolve(approvals.approvalRequestLogicalPath('terminal', record.id)),
          { force: true }
        );
    }
    for (const root of Object.values(approvals.approvalStoreRoots()))
      safeRmSync(pathResolver.rootResolve(root + '/terminal'), { recursive: true, force: true });
    safeRmSync(memoryPromotionQueuePath(), { force: true });
    for (const file of cleanup) safeRmSync(file, { recursive: true, force: true });
  });
  cleanup.clear();
  vi.unstubAllEnvs();
});
function fixture() {
  const suffix = randomUUID().slice(0, 8);
  const scope = {
    tier: 'confidential' as const,
    tenant_slug: 'review-ui-' + suffix,
    organization_id: 'org-review',
    project_id: 'project-review',
  };
  const candidate = createMemoryPromotionCandidate({
    candidateId: 'MEM-REVIEW-UI-' + suffix,
    sourceType: 'task_session',
    sourceRef: 'task_session:review-' + suffix,
    knowledgeDomain: 'organization',
    proposedMemoryKind: 'sop',
    summary: 'Reconcile source record totals before preparing the scoped report.',
    evidenceRefs: ['task_session:review-' + suffix],
    sensitivityTier: 'confidential',
    scope,
    ratificationRequired: true,
  });
  const audit = auditChain.record({
    agentId: 'synthetic-learning-review',
    action: 'knowledge_promotion_candidate',
    operation: 'enqueue',
    result: 'completed',
    tenantSlug: scope.tenant_slug,
  });
  candidate.audit_ref = 'audit:' + audit.id;
  enqueueMemoryPromotionCandidate(candidate);
  candidates.push(candidate);
  cleanup.add(pathResolver.rootResolve('active/shared/runtime/tenants/' + scope.tenant_slug));
  cleanup.add(pathResolver.knowledge('confidential/' + scope.tenant_slug));
  const curation = {
    title: 'Source record reconciliation SOP',
    summary: candidate.summary,
    content:
      'Compare source record totals. Investigate every discrepancy and retain its evidence before publishing the report.',
    evidence_refs: candidate.evidence_refs,
  };
  const address = { candidateId: candidate.candidate_id, scope };
  const requester = {
    requestedBy: 'agent:synthetic-learning-review',
    actorId: 'agent:synthetic-learning-review',
  };
  const current = () => loadMemoryPromotionCandidate(candidate.candidate_id, scope)!;
  const curate = () =>
    curateScopedLearningCandidate({
      ...address,
      curation,
      expectedPayloadDigest: approvedLearningPayloadDigest(current()),
    });
  const request = () =>
    requestScopedLearningCandidateApproval({
      ...address,
      requester,
      expectedPayloadDigest: approvedLearningPayloadDigest(current()),
    });
  const approve = (ref: string) => {
    const memberId = 'review-ui-' + suffix;
    cleanup.add(memberProfilePath(memberId));
    withExecutionContext('sovereign_concierge', () =>
      writeMemberProfile({
        member_id: memberId,
        display_name: 'Synthetic learning reviewer',
        status: 'active',
        memberships: [{ tenant_slug: scope.tenant_slug, role: 'owner' }],
        access_registrations: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    );
    const requestId = ref.split(':')[1]!;
    const record = approvals.loadApprovalRequest('terminal', requestId)!;
    approvals.decideApprovalRequest('infrastructure_sentinel', {
      channel: 'terminal',
      requestId,
      decision: 'approved',
      decidedBy: 'user:' + memberId,
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      deciderIdentitySource: 'server_resolved',
      deciderPrincipal: {
        actor: { kind: 'human', id: 'user:' + memberId },
        provider: 'browser-session',
      },
      presentedDigest: approvals.computeApprovalPresentedDigest(record),
    });
    return memberId;
  };
  return { candidate, scope, curation, address, requester, current, curate, request, approve };
}

describe('scoped learning UI workflow', () => {
  it('persists curation, rejects stale edits, and recovers the canonical reference on reload', () => {
    const f = fixture();
    const stale = approvedLearningPayloadDigest(f.candidate);
    const saved = f.curate();
    expect(saved.learning.state).toBe('draft');
    expect(f.current().curation).toEqual(f.curation);
    expect(() =>
      curateScopedLearningCandidate({
        ...f.address,
        expectedPayloadDigest: stale,
        curation: {
          ...f.curation,
          content: 'A stale editor must not replace the durable curated procedure.',
        },
      })
    ).toThrow(/STALE_PAYLOAD/);
    const pending = f.request();
    expect(pending.learning.state).toBe('pending');
    expect(f.request().learning.approvalRef).toBe(pending.learning.approvalRef);
    expect(inspectScopedLearningCandidate(f.address).learning).toEqual(pending.learning);
  });

  it('keeps curation durable when request creation fails, and recovers an unknown created outcome', () => {
    const f = fixture();
    const original = approvals.createApprovalRequest;
    vi.spyOn(approvals, 'createApprovalRequest').mockImplementationOnce(() => {
      throw new Error('synthetic failure before creation');
    });
    expect(() =>
      requestScopedLearningApproval({
        candidate: { ...f.candidate, curation: f.curation },
        requester: f.requester,
      })
    ).toThrow(/before creation/);
    expect(f.current().curation).toEqual(f.curation);
    expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('draft');
    vi.mocked(approvals.createApprovalRequest).mockImplementationOnce((...args) => {
      original(...args);
      throw new Error('synthetic lost response after creation');
    });
    expect(() =>
      requestScopedLearningApproval({ candidate: f.current(), requester: f.requester })
    ).toThrow(/lost response/);
    const recovered = inspectScopedLearningCandidate(f.address);
    expect(recovered.learning.state).toBe('pending');
    expect(recovered.learning.approvalRef).toMatch(/^terminal:/);
    expect(
      requestScopedLearningApproval({ candidate: f.current(), requester: f.requester }).ref
    ).toBe(recovered.learning.approvalRef);
  });

  it('freezes pending payload through queued updates, merge enqueue, and duplicate append paths', () => {
    const f = fixture();
    f.curate();
    f.request();
    const before = f.current();
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        ...f.address,
        status: 'queued',
        curation: {
          ...f.curation,
          content: 'Changed procedure after a human review was already requested.',
        },
      })
    ).toThrow(/IMMUTABLE/);
    expect(() =>
      enqueueMemoryPromotionCandidate({
        ...before,
        evidence_refs: [...before.evidence_refs, 'task_session:unreviewed'],
      })
    ).toThrow(/IMMUTABLE/);
    expect(() =>
      enqueueMemoryPromotionCandidate({ ...before, source_ref: 'task_session:other-source' })
    ).toThrow(/IMMUTABLE/);
    expect(() =>
      requestScopedLearningApproval({
        candidate: {
          ...before,
          summary: 'A stale detached source summary must not overwrite the canonical candidate.',
        },
        requester: f.requester,
      })
    ).toThrow(/STALE_PAYLOAD/);
    expect(f.current()).toEqual(before);
  });

  it('preserves same-id sibling scope and rejects physical duplicate ambiguity', () => {
    const f = fixture();
    f.curate();
    f.request();
    const sibling = { ...f.current(), scope: { ...f.scope, project_id: 'sibling-project' } };
    enqueueMemoryPromotionCandidate(sibling);
    expect(memoryPromotionCandidateKey(sibling)).not.toBe(memoryPromotionCandidateKey(f.current()));
    updateMemoryPromotionCandidateStatus({
      candidateId: sibling.candidate_id,
      scope: sibling.scope,
      status: 'queued',
      curation: {
        ...f.curation,
        content: 'A separate project may curate its own independently scoped procedure.',
      },
    });
    expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('pending');
    const file = memoryPromotionQueuePath(f.scope);
    safeWriteFile(
      file,
      String(safeReadFile(file, { encoding: 'utf8' })) + JSON.stringify(f.current()) + '\n'
    );
    expect(inspectScopedLearningReview(f.current()).learning.state).toBe('error');
    expect(() => f.request()).toThrow(/CANDIDATE_CONFLICT/);
  });

  it('keeps owner/audience restrictions unsupported and rejects unselected curation evidence', () => {
    const f = fixture();
    for (const restrictions of [
      { owner_nhi: 'user:owner' },
      { allowed_audience: ['user:owner'] },
    ]) {
      const restricted = { ...f.candidate, scope: { ...f.scope, ...restrictions } };
      expect(inspectScopedLearningReview(restricted)).toMatchObject({
        candidate: restricted,
        learning: { state: 'unsupported' },
      });
    }
    expect(() =>
      curateScopedLearningCandidate({
        ...f.address,
        expectedPayloadDigest: approvedLearningPayloadDigest(f.current()),
        curation: { ...f.curation, evidence_refs: ['task_session:not-selected'] },
      })
    ).toThrow(/evidence refs/);
    expect(f.current().curation).toBeUndefined();
  });

  it('does not infer approval from queue labels and keeps terminal reviews frozen', () => {
    const f = fixture();
    f.curate();
    expect(inspectScopedLearningReview({ ...f.current(), status: 'approved' }).learning.state).toBe(
      'draft'
    );
    const pending = f.request();
    approvals.cancelApprovalRequest('infrastructure_sentinel', {
      channel: 'terminal',
      requestId: pending.learning.approvalRef!.split(':')[1]!,
      cancelledBy: 'synthetic',
      reason: 'test',
    });
    expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('rejected');
    expect(() =>
      curateScopedLearningCandidate({
        ...f.address,
        expectedPayloadDigest: approvedLearningPayloadDigest(f.current()),
        curation: {
          ...f.curation,
          summary: 'Different content requires a separate candidate and its own review.',
        },
      })
    ).toThrow(/IMMUTABLE/);
  });

  it('publishes through complete verified workflow and makes concurrent retries converge', async () => {
    const f = fixture();
    f.curate();
    const pending = f.request();
    const reviewer = f.approve(pending.learning.approvalRef!);
    expect(f.current().status).toBe('queued');
    expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('approved');
    const input = {
      ...f.address,
      expectedPayloadDigest: approvedLearningPayloadDigest(f.current()),
    };
    const [first, second] = await withExecutionContextAsync('chronos_gateway', () =>
      Promise.all([publishScopedLearningCandidate(input), publishScopedLearningCandidate(input)])
    );
    expect(first.learning.state).toBe('published');
    expect(second.learning.publication).toEqual(first.learning.publication);
    expect((await publishScopedLearningCandidate(input)).learning.publication).toEqual(
      first.learning.publication
    );
    const record = approvals.loadApprovalRequest(
      'terminal',
      first.learning.approvalRef!.split(':')[1]!
    )!;
    expect(record.consumption?.consumer).toBe('scoped_learning_publication');
    withExecutionContext('chronos_gateway', () => {
      expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('published');
      expect(resolveRole()).toBe('chronos_gateway');
      // The proof reader derives fixed paths from the approved scope; forged
      // receipt paths cannot select another tenant's artifact or a reader role.
      expect(
        verifyScopedLearningPublication({
          ...f.current(),
          learning_publication: {
            ...first.learning.publication!,
            markdown_path: 'knowledge/confidential/another-tenant/secret.md',
          },
        })
      ).toBeUndefined();
      expect(resolveRole()).toBe('chronos_gateway');
      expect(
        verifyScopedLearningPublication({
          ...f.current(),
          scope: { ...f.scope, project_id: 'unauthorized-sibling' },
        })
      ).toBeUndefined();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 4 * 24 * 3600000);
      expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('published');
    });
    withExecutionContext('sovereign_concierge', () =>
      writeMemberProfile({
        member_id: reviewer,
        display_name: 'Synthetic learning reviewer',
        status: 'suspended',
        memberships: [{ tenant_slug: f.scope.tenant_slug, role: 'owner' }],
        access_registrations: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    );
    withExecutionContext('chronos_gateway', () => {
      expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('error');
      expect(resolveRole()).toBe('chronos_gateway');
    });
  });

  it('rejects wrong scope, downgraded reviewer and altered receipt paths before publication content reads', async () => {
    const f = fixture();
    f.curate();
    const pending = f.request();
    const reviewer = f.approve(pending.learning.approvalRef!);
    await withExecutionContextAsync('chronos_gateway', () =>
      publishScopedLearningCandidate({
        ...f.address,
        expectedPayloadDigest: approvedLearningPayloadDigest(f.current()),
      })
    );
    const published = f.current();
    const receipt = published.learning_publication!;
    // Force the historical-proof branch, where valid consumed artifacts remain usable.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 4 * 24 * 3600000);
    const secureRead = vi.spyOn(secureIo, 'safeReadFile');
    const textRead = vi.spyOn(textIo, 'readTextFile');
    const assertNoPublicationRead = (invalid: MemoryCandidate) => {
      secureRead.mockClear();
      textRead.mockClear();
      withExecutionContext('chronos_gateway', () => {
        expect(() => inspectScopedLearningPublication(invalid)).toThrow();
        expect(verifyScopedLearningPublication(invalid)).toBeUndefined();
        expect(() =>
          verifyScopedLearningApprovalRef(invalid, pending.learning.approvalRef!)
        ).toThrow();
        expect(resolveRole()).toBe('chronos_gateway');
      });
      const publicationReads = [...secureRead.mock.calls, ...textRead.mock.calls].filter(([file]) =>
        String(file).replace(/\\/g, '/').includes('/knowledge/confidential/')
      );
      expect(publicationReads).toEqual([]);
    };
    for (const invalid of [
      { ...published, scope: { ...f.scope, project_id: 'wrong-project' } },
      { ...published, promoted_ref: 'knowledge/confidential/other-tenant/secret.md' },
      {
        ...published,
        learning_publication: {
          ...receipt,
          markdown_path: 'knowledge/confidential/other-tenant/secret.md',
        },
      },
      {
        ...published,
        learning_publication: {
          ...receipt,
          record_path: 'knowledge/confidential/other-tenant/secret.json',
        },
      },
      {
        ...published,
        learning_publication: { ...receipt, scope: { ...f.scope, organization_id: 'wrong-org' } },
      },
    ])
      assertNoPublicationRead(invalid);
    withExecutionContext('sovereign_concierge', () =>
      writeMemberProfile({
        member_id: reviewer,
        display_name: 'Synthetic learning reviewer',
        status: 'active',
        memberships: [{ tenant_slug: f.scope.tenant_slug, role: 'viewer' }],
        access_registrations: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    );
    assertNoPublicationRead(published);
  });

  it('reconciles consumption persisted before the final queue update without changing artifacts', async () => {
    const f = fixture();
    f.curate();
    const pending = f.request();
    f.approve(pending.learning.approvalRef!);
    const input = {
      ...f.address,
      expectedPayloadDigest: approvedLearningPayloadDigest(f.current()),
    };
    const original = memoryQueue.updateMemoryPromotionCandidateStatus;
    const statusWrite = vi.spyOn(memoryQueue, 'updateMemoryPromotionCandidateStatus');
    statusWrite.mockImplementation((update) => {
      if (update.status === 'promoted') throw new Error('synthetic crash after consumption');
      return original(update);
    });
    await withExecutionContextAsync('chronos_gateway', async () => {
      await expect(publishScopedLearningCandidate(input)).rejects.toThrow(
        /crash after consumption/
      );
    });
    statusWrite.mockRestore();
    expect(f.current().status).toBe('approved');
    expect(f.current().learning_publication).toBeUndefined();
    const requestId = pending.learning.approvalRef!.split(':')[1]!;
    const consumed = approvals.loadApprovalRequest('terminal', requestId)!.consumption;
    expect(consumed?.consumer).toBe('scoped_learning_publication');
    const partial = inspectScopedLearningPublication(f.current());
    expect(inspectScopedLearningCandidate(f.address).learning.state).toBe('approved');
    const recovered = await withExecutionContextAsync('chronos_gateway', () =>
      publishScopedLearningCandidate(input)
    );
    expect(recovered.learning.state).toBe('published');
    expect(recovered.learning.publication).toEqual(partial);
    expect(approvals.loadApprovalRequest('terminal', requestId)!.consumption).toEqual(consumed);
  });
});
