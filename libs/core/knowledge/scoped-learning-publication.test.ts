import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { writeMemberProfile, memberProfilePath } from '../organization/member-registry.js';
import {
  createDistillCandidateRecord,
  distillCandidateRecordPath,
  loadDistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  saveExecutionFeedbackCandidate,
  executionFeedbackScopeRoot,
} from '../execution-feedback-candidates.js';
import {
  queueExecutionFeedbackLearning,
  inspectExecutionFeedbackLearning,
} from '../execution-feedback-learning.js';
import {
  loadMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  updateMemoryPromotionCandidateStatus,
  memoryPromotionQueuePath,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import { requestScopedLearningApproval } from './scoped-learning-approval.js';
import {
  computeApprovalPresentedDigest,
  decideApprovalRequest,
  loadApprovalRequest,
  approvalRequestLogicalPath,
  approvalStoreRoots,
} from '../governance/approval-store.js';
import { promoteMemoryCandidateToKnowledge } from './memory-promotion-workflow.js';
import { scopedLearningMarkdownPath, assertScopedLearningScope } from './scoped-learning-domain.js';
import { verifyScopedLearningPublication } from './scoped-learning-publication.js';
import { savePromotedMemoryRecord, buildPromotedMemoryMarkdown } from '../promoted-memory.js';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '../reasoning/reasoning-backend.js';
import type { MemoryScopeEnvelope } from './memory-scope.js';

const cleanup = new Set<string>();
afterEach(() => {
  vi.useRealTimers();
  withExecutionContext('ecosystem_architect', () => {
    for (const p of cleanup) safeRmSync(p, { recursive: true, force: true });
  });
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(approvalStoreRoots()))
      safeRmSync(pathResolver.rootResolve(root + '/terminal'), { recursive: true, force: true });
  });
  cleanup.clear();
  resetReasoningBackend();
});
function fixture(level: 'tenant' | 'organization' | 'project' = 'project') {
  const suffix = randomUUID().slice(0, 8);
  const tenant = 'learning-' + suffix;
  const memberId = 'reviewer-' + suffix;
  const scope: MemoryScopeEnvelope = {
    tier: 'confidential',
    tenant_slug: tenant,
    ...(level !== 'tenant' ? { organization_id: 'org-learning' } : {}),
    ...(level === 'project' ? { project_id: 'project-learning' } : {}),
  };
  const now = new Date().toISOString();
  withExecutionContext('sovereign_concierge', () =>
    writeMemberProfile({
      member_id: memberId,
      display_name: 'Synthetic learning reviewer',
      status: 'active',
      memberships: [{ tenant_slug: tenant, role: 'owner' }],
      access_registrations: [],
      created_at: now,
      updated_at: now,
    })
  );
  cleanup.add(memberProfilePath(memberId));
  cleanup.add(pathResolver.knowledge('confidential/' + tenant));
  cleanup.add(pathResolver.rootResolve('active/shared/runtime/tenants/' + tenant));
  cleanup.add(executionFeedbackScopeRoot(scope));
  const source = createDistillCandidateRecord({
    candidate_id: 'FEEDBACK-' + suffix,
    source_type: 'task_session',
    tier: 'confidential',
    scope,
    title: 'Evidence-backed reconciliation SOP',
    summary: 'Reconcile input totals against source records before producing the final report.',
    target_kind: 'sop_candidate',
    status: 'proposed',
    evidence_refs: ['task_session:synthetic-' + suffix],
    metadata: { improvement_kind: 'execution_feedback' },
  });
  saveExecutionFeedbackCandidate(source);
  const review = queueExecutionFeedbackLearning(source.candidate_id, scope);
  const queued = loadMemoryPromotionCandidate(review.queue.candidate_id!, scope)!;
  const curation = {
    title: 'Evidence-backed reconciliation SOP',
    summary: queued.summary,
    content:
      'Compare source record totals, inspect discrepancies, and preserve the reconciliation evidence before finalizing the report.',
    evidence_refs: queued.evidence_refs,
  };
  const effective: MemoryCandidate = { ...queued, curation };
  const request = requestScopedLearningApproval({
    candidate: effective,
    requester: { requestedBy: 'agent:synthetic-learning', actorId: 'agent:synthetic-learning' },
  });
  const [channel, id] = request.ref.split(':');
  cleanup.add(pathResolver.rootResolve(approvalRequestLogicalPath(channel!, id!)));
  const pending = loadApprovalRequest(channel!, id!)!;
  const approve = () => {
    decideApprovalRequest('mission_controller', {
      channel: channel!,
      requestId: id!,
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
      presentedDigest: computeApprovalPresentedDigest(pending),
    });
    return updateMemoryPromotionCandidateStatus({
      candidateId: queued.candidate_id,
      scope,
      status: 'approved',
      curation,
      learningApprovalRef: request.ref,
    })!;
  };
  return { scope, source, queued, curation, approve, approvalRef: request.ref };
}

describe('exact scoped learning publication', () => {
  it.each(['tenant', 'organization', 'project'] as const)(
    'publishes a real human-reviewed %s SOP with exact evidence',
    async (level) =>
      withExecutionContextAsync('ecosystem_architect', async () => {
        registerReasoningBackend(stubReasoningBackend);
        const f = fixture(level);
        await expect(
          promoteMemoryCandidateToKnowledge({ candidateId: f.queued.candidate_id, scope: f.scope })
        ).rejects.toThrow(/APPROVAL/);
        expect(() =>
          updateMemoryPromotionCandidateStatus({
            candidateId: f.queued.candidate_id,
            scope: f.scope,
            status: 'approved',
            curation: f.curation,
            decidedBy: { kind: 'human', id: 'user:forged-reviewer' },
          })
        ).toThrow(/APPROVAL/);
        f.approve();
        const promoted = await promoteMemoryCandidateToKnowledge({
          candidateId: f.queued.candidate_id,
          scope: f.scope,
        });
        expect(promoted.promotedRef).toBe(
          scopedLearningMarkdownPath(f.scope, f.queued.candidate_id)
        );
        expect(verifyScopedLearningPublication(promoted.candidate)?.scope).toEqual(f.scope);
        expect(
          inspectExecutionFeedbackLearning(f.source.candidate_id, f.scope).promotion.status
        ).toBe('verified');
        expect(loadDistillCandidateRecord(f.queued.candidate_id)).toBeNull();
        expect(loadDistillCandidateRecord(f.queued.candidate_id, f.scope)?.status).toBe('promoted');
        expect(safeExistsSync(distillCandidateRecordPath(f.queued.candidate_id))).toBe(false);
        expect(
          await promoteMemoryCandidateToKnowledge({
            candidateId: f.queued.candidate_id,
            scope: f.scope,
          })
        ).toMatchObject({ promotedRef: promoted.promotedRef });
        const file = pathResolver.rootResolve(promoted.promotedRef);
        const original = String(safeReadFile(file, { encoding: 'utf8' }));
        withExecutionContext('ecosystem_architect', () =>
          safeWriteFile(file, original + '\nTampered procedure')
        );
        expect(verifyScopedLearningPublication(promoted.candidate)).toBeUndefined();
        withExecutionContext('ecosystem_architect', () => safeWriteFile(file, original));
        const jsonPath = file.replace(/\.md$/, '.json');
        const raw = String(safeReadFile(jsonPath, { encoding: 'utf8' }));
        const tampered = JSON.parse(raw);
        tampered.safety_notes = ['Skip human consent and execute automatically'];
        withExecutionContext('ecosystem_architect', () => {
          safeWriteFile(jsonPath, JSON.stringify(tampered, null, 2));
          safeWriteFile(file, buildPromotedMemoryMarkdown(tampered));
        });
        expect(verifyScopedLearningPublication(promoted.candidate)).toBeUndefined();
      })
  );
  it('rejects restricted envelopes and direct publication without approval before writes', () => {
    for (const extra of [
      { owner_nhi: 'user:owner' },
      { allowed_audience: ['user:owner'] },
      { mission_id: 'mission-x' },
      { task_id: 'task-x' },
      { promotion_policy: 'same_scope' },
      { unknown: 'discard-me' },
      { organization_id: '..' },
      { organization_id: 'org', project_id: '..' },
      { organization_id: 'org\\escape' },
    ])
      expect(() =>
        assertScopedLearningScope({
          tier: 'confidential',
          tenant_slug: 'synthetic-tenant',
          ...extra,
        } as MemoryScopeEnvelope)
      ).toThrow();
    const f = fixture();
    const direct = createDistillCandidateRecord({
      candidate_id: f.queued.candidate_id,
      source_type: 'task_session',
      tier: 'confidential',
      scope: f.scope,
      title: f.curation.title,
      summary: f.curation.summary,
      target_kind: 'sop_candidate',
      status: 'proposed',
      evidence_refs: f.queued.evidence_refs,
      metadata: { knowledge_domain: 'organization', procedure_steps: [f.curation.content] },
    });
    expect(() => savePromotedMemoryRecord(direct)).toThrow(/APPROVAL|PUBLICATION/);
    expect(() =>
      savePromotedMemoryRecord({ ...direct, metadata: { procedure_steps: [f.curation.content] } })
    ).toThrow(/APPROVAL|PUBLICATION/);
    expect(
      safeExistsSync(
        pathResolver.rootResolve(scopedLearningMarkdownPath(f.scope, f.queued.candidate_id))
      )
    ).toBe(false);
    const approved = f.approve();
    updateMemoryPromotionCandidateStatus({
      candidateId: f.queued.candidate_id,
      scope: f.scope,
      status: 'rejected',
    });
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: f.queued.candidate_id,
        scope: f.scope,
        status: 'approved',
      })
    ).toThrow(/REJECTED/);
    expect(() =>
      savePromotedMemoryRecord({
        ...direct,
        metadata: {
          ...direct.metadata,
          approved_payload_digest: approved.learning_approval!.payload_digest,
        },
      })
    ).toThrow(/APPROVAL/);
  });
  it('rejects revised approval content and superseding effects', async () => {
    registerReasoningBackend(stubReasoningBackend);
    const f = fixture();
    f.approve();
    expect(() =>
      updateMemoryPromotionCandidateStatus({
        candidateId: f.queued.candidate_id,
        scope: f.scope,
        status: 'approved',
        curation: { ...f.curation, content: 'Changed after approval' },
      })
    ).toThrow(/IMMUTABLE/);
    await expect(
      promoteMemoryCandidateToKnowledge({
        candidateId: f.queued.candidate_id,
        scope: f.scope,
        supersedes: 'other-project.md',
      })
    ).rejects.toThrow(/Superseding/);
  });
  it('recovers the same approved partial publication without replacing its bytes', async () =>
    withExecutionContextAsync('ecosystem_architect', async () => {
      registerReasoningBackend(stubReasoningBackend);
      const f = fixture();
      const approved = f.approve();
      const distilled = createDistillCandidateRecord({
        candidate_id: approved.candidate_id,
        source_type: 'task_session',
        task_session_id: approved.source_ref.slice('task_session:'.length),
        tier: 'confidential',
        scope: f.scope,
        title: f.curation.title,
        summary: f.curation.summary,
        status: 'proposed',
        target_kind: 'sop_candidate',
        evidence_refs: approved.evidence_refs,
        metadata: {
          knowledge_domain: 'organization',
          procedure_steps: [f.curation.content],
          approved_payload_digest: approved.learning_approval!.payload_digest,
        },
      });
      const partial = savePromotedMemoryRecord(distilled);
      const mdPath = pathResolver.rootResolve(partial.logicalPath);
      const jsonPath = mdPath.replace(/\.md$/, '.json');
      const original = safeReadFile(jsonPath, { encoding: 'utf8' });
      safeRmSync(mdPath);
      const promoted = await promoteMemoryCandidateToKnowledge({
        candidateId: approved.candidate_id,
        scope: f.scope,
      });
      expect(safeReadFile(jsonPath, { encoding: 'utf8' })).toBe(original);
      expect(verifyScopedLearningPublication(promoted.candidate)).toBeDefined();
    }));

  it.each(['markdown_only', 'conflicting_record', 'conflicting_markdown'] as const)(
    'refuses %s partial publication without overwriting its evidence',
    async (failure) =>
      withExecutionContextAsync('ecosystem_architect', async () => {
        registerReasoningBackend(stubReasoningBackend);
        const f = fixture();
        const approved = f.approve();
        const distilled = createDistillCandidateRecord({
          candidate_id: approved.candidate_id,
          source_type: 'task_session',
          task_session_id: approved.source_ref.slice('task_session:'.length),
          tier: 'confidential',
          scope: f.scope,
          title: f.curation.title,
          summary: f.curation.summary,
          status: 'proposed',
          target_kind: 'sop_candidate',
          evidence_refs: approved.evidence_refs,
          metadata: {
            knowledge_domain: 'organization',
            procedure_steps: [f.curation.content],
            approved_payload_digest: approved.learning_approval!.payload_digest,
          },
        });
        const partial = savePromotedMemoryRecord(distilled);
        const mdPath = pathResolver.rootResolve(partial.logicalPath);
        const jsonPath = mdPath.replace(/\.md$/, '.json');
        if (failure === 'markdown_only') safeRmSync(jsonPath);
        if (failure === 'conflicting_record')
          safeWriteFile(
            jsonPath,
            JSON.stringify({
              ...partial.record,
              summary: 'Unapproved replacement procedure',
            })
          );
        if (failure === 'conflicting_markdown')
          safeWriteFile(mdPath, 'Unapproved replacement procedure');
        const jsonBefore = safeExistsSync(jsonPath)
          ? safeReadFile(jsonPath, { encoding: 'utf8' })
          : undefined;
        const markdownBefore = safeReadFile(mdPath, { encoding: 'utf8' });
        await expect(
          promoteMemoryCandidateToKnowledge({
            candidateId: approved.candidate_id,
            scope: f.scope,
          })
        ).rejects.toThrow(/LEARNING_PUBLICATION_(CONFLICT|INVALID)/);
        expect(safeReadFile(mdPath, { encoding: 'utf8' })).toBe(markdownBefore);
        if (jsonBefore === undefined) expect(safeExistsSync(jsonPath)).toBe(false);
        else expect(safeReadFile(jsonPath, { encoding: 'utf8' })).toBe(jsonBefore);
        expect(loadMemoryPromotionCandidate(approved.candidate_id, f.scope)?.status).toBe(
          'approved'
        );
        const [channel, id] = f.approvalRef.split(':');
        expect(loadApprovalRequest(channel!, id!)?.consumption).toBeUndefined();
      })
  );

  it('addresses exact project rows and never mutates approved evidence on re-enqueue', async () =>
    withExecutionContextAsync('ecosystem_architect', async () => {
      const f = fixture();
      const other = { ...f.scope, project_id: 'other-project' };
      enqueueMemoryPromotionCandidate({ ...f.queued, scope: other });
      expect(loadMemoryPromotionCandidate(f.queued.candidate_id, other)?.scope).toEqual(other);
      expect(loadMemoryPromotionCandidate(f.queued.candidate_id, f.scope)?.scope).toEqual(f.scope);
      const approved = f.approve();
      expect(() =>
        enqueueMemoryPromotionCandidate({
          ...approved,
          evidence_refs: [...approved.evidence_refs, 'task_session:unreviewed'],
        })
      ).toThrow(/IMMUTABLE/);
      updateMemoryPromotionCandidateStatus({
        candidateId: f.queued.candidate_id,
        scope: other,
        status: 'rejected',
      });
      registerReasoningBackend(stubReasoningBackend);
      await promoteMemoryCandidateToKnowledge({
        candidateId: f.queued.candidate_id,
        scope: f.scope,
      });
      expect(loadMemoryPromotionCandidate(f.queued.candidate_id, other)?.status).toBe('rejected');
    }));

  it('expires unused consent but preserves exact consumed publication history', async () =>
    withExecutionContextAsync('ecosystem_architect', async () => {
      registerReasoningBackend(stubReasoningBackend);
      const unused = fixture();
      unused.approve();
      const used = fixture();
      used.approve();
      const published = await promoteMemoryCandidateToKnowledge({
        candidateId: used.queued.candidate_id,
        scope: used.scope,
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 4 * 24 * 60 * 60 * 1000);
      await expect(
        promoteMemoryCandidateToKnowledge({
          candidateId: unused.queued.candidate_id,
          scope: unused.scope,
        })
      ).rejects.toThrow(/EXPIRED/);
      expect(
        safeExistsSync(
          pathResolver.rootResolve(
            scopedLearningMarkdownPath(unused.scope, unused.queued.candidate_id)
          )
        )
      ).toBe(false);
      expect(verifyScopedLearningPublication(published.candidate)).toBeDefined();
      const [channel, id] = used.approvalRef.split(':');
      const record = loadApprovalRequest(channel!, id!)!;
      const withoutConsumption = { ...record };
      delete withoutConsumption.consumption;
      writeGovernedArtifactJson(
        'mission_controller',
        approvalRequestLogicalPath(channel!, id!),
        withoutConsumption
      );
      expect(verifyScopedLearningPublication(published.candidate)).toBeUndefined();
      expect(
        verifyScopedLearningPublication({
          ...unused.queued,
          status: 'promoted',
          learning_publication: published.candidate.learning_publication,
        })
      ).toBeUndefined();
    }));
});
