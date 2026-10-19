import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDistillCandidateRecord } from './knowledge/distill-candidate-registry.js';
import {
  inspectExecutionFeedbackLearning,
  queueExecutionFeedbackLearning,
} from './execution-feedback-learning.js';
import {
  loadMemoryPromotionCandidate,
  memoryPromotionQueuePath,
  updateMemoryPromotionCandidateStatus,
} from './knowledge/memory-promotion-queue.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  executionFeedbackCandidatePath,
  executionFeedbackScopeRoot,
  loadExecutionFeedbackCandidate,
  saveExecutionFeedbackCandidate,
  listExecutionFeedbackCandidates,
} from './execution-feedback-candidates.js';
import type { MemoryScopeEnvelope } from './knowledge/memory-scope.js';
import * as queueModule from './knowledge/memory-promotion-queue.js';
import {
  materializeExecutionFeedbackCandidate,
  recordExecutionFeedback,
} from './execution-feedback.js';
import * as registryModule from './knowledge/distill-candidate-registry.js';
const scope = { tier: 'confidential' as const, tenant_slug: 'synthetic-learning-a' };
const ids = new Set<string>();
const extraRoots = new Set<string>();
function candidate(overrides: Record<string, unknown> = {}) {
  const row = createDistillCandidateRecord({
    source_type: 'task_session',
    tier: 'confidential',
    scope,
    title: 'Synthetic meeting preparation',
    summary: 'Share the fictional brief before the decision meeting.',
    status: 'proposed',
    target_kind: 'procedure',
    evidence_refs: ['intent:synthetic-meeting'],
    metadata: { improvement_kind: 'execution_feedback', review_required: true },
    ...overrides,
  });
  if (row.scope) extraRoots.add(executionFeedbackScopeRoot(row.scope));
  saveExecutionFeedbackCandidate(row);
  ids.add(row.candidate_id);
  return row;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const id of ids)
    safeRmSync(pathResolver.shared('runtime/distill-candidates/' + id + '.json'), { force: true });
  safeRmSync(executionFeedbackScopeRoot(scope), { recursive: true, force: true });
  for (const root of extraRoots) safeRmSync(root, { recursive: true, force: true });
  extraRoots.clear();
  ids.clear();
  safeRmSync(memoryPromotionQueuePath(scope), { force: true });
});
describe('execution feedback learning handoff', () => {
  it('reports a proposed candidate without approving, publishing, or claiming retrieval', () => {
    const row = candidate();
    const file = executionFeedbackCandidatePath(row.candidate_id, scope);
    const before = safeReadFile(file, { encoding: 'utf8' });
    expect(inspectExecutionFeedbackLearning(row.candidate_id, scope)).toMatchObject({
      queue: { status: 'not_queued' },
      human_review: { status: 'pending' },
      promotion: { status: 'none' },
      retrieval: { status: 'unmeasured' },
    });
    expect(safeReadFile(file, { encoding: 'utf8' })).toEqual(before);
    expect(safeExistsSync(memoryPromotionQueuePath(scope))).toBe(false);
  });
  it('queues once with exact scope and an immutable digest link, without ratification', () => {
    const row = candidate();
    const first = queueExecutionFeedbackLearning(row.candidate_id, scope);
    const second = queueExecutionFeedbackLearning(row.candidate_id, scope);
    expect(second.queue.candidate_id).toEqual(first.queue.candidate_id);
    const queued = loadMemoryPromotionCandidate(first.queue.candidate_id!, scope)!;
    expect(queued).toMatchObject({ status: 'queued', scope, ratification_required: true });
    expect(queued.ratified_at).toBeUndefined();
    expect(queued.decided_by).toBeUndefined();
    expect(loadExecutionFeedbackCandidate(row.candidate_id, scope)?.status).toBe('proposed');
  });
  it('refuses another tenant and refuses adoption of a legacy unscoped candidate', () => {
    const row = candidate();
    expect(() =>
      queueExecutionFeedbackLearning(row.candidate_id, {
        ...scope,
        tenant_slug: 'synthetic-learning-b',
      })
    ).toThrow(/SCOPE|NOT_FOUND/);
    const legacy = candidate({ tier: 'personal', scope: undefined });
    expect(() => queueExecutionFeedbackLearning(legacy.candidate_id)).toThrow(/SCOPE|NOT_FOUND/);
    expect(() => queueExecutionFeedbackLearning(legacy.candidate_id, scope)).toThrow(
      /SCOPE|NOT_FOUND/
    );
  });
  it('fails closed when the source changed after queue handoff', () => {
    const row = candidate();
    queueExecutionFeedbackLearning(row.candidate_id, scope);
    saveExecutionFeedbackCandidate({
      ...loadExecutionFeedbackCandidate(row.candidate_id, scope)!,
      summary: 'A different fictional change.',
    });
    expect(inspectExecutionFeedbackLearning(row.candidate_id, scope).blockers).toContain(
      'source_digest_mismatch'
    );
    expect(() => queueExecutionFeedbackLearning(row.candidate_id, scope)).toThrow(/LINK/);
  });
  it('does not turn a legacy promoted label into evidence of published knowledge', () => {
    const row = candidate({ status: 'promoted', promoted_ref: 'procedure-improvement:synthetic' });
    expect(inspectExecutionFeedbackLearning(row.candidate_id, scope)).toMatchObject({
      queue: { status: 'not_queued' },
      human_review: { status: 'pending' },
      promotion: { status: 'unverified' },
      retrieval: { status: 'unmeasured' },
    });
  });
  it('reads legacy state only with explicit unscoped inspection, without adoption', () => {
    const row = candidate({ tier: 'personal', scope: undefined });
    expect(() => inspectExecutionFeedbackLearning(row.candidate_id, scope)).toThrow(/NOT_FOUND/);
    expect(inspectExecutionFeedbackLearning(row.candidate_id)).toMatchObject({
      scope_disposition: 'legacy_unscoped',
      queue: { status: 'not_queued' },
      human_review: { status: 'pending' },
      promotion: { status: 'none' },
      retrieval: { status: 'unmeasured' },
      blockers: ['legacy_scope_requires_explicit_classification'],
    });
    expect(() => queueExecutionFeedbackLearning(row.candidate_id, scope)).toThrow();
    expect(loadExecutionFeedbackCandidate(row.candidate_id)?.scope).toBeUndefined();
  });
  it.each([
    { organization_id: 'ORG-SYNTHETIC' },
    { organization_id: 'ORG-SYNTHETIC', project_id: 'PRJ-SYNTHETIC' },
    { mission_id: 'MSN-SYNTHETIC' },
    { mission_id: 'MSN-SYNTHETIC', task_id: 'TASK-SYNTHETIC' },
    { owner_nhi: 'user:synthetic-a' },
    { allowed_audience: ['user:synthetic-a'] },
    { promotion_policy: 'same_scope' },
    { tier: 'public' },
  ])('keeps unsupported publisher scope read-only: %j', (extra) => {
    const restricted = { ...scope, ...extra } as MemoryScopeEnvelope;
    const row = candidate({ scope: restricted, tier: restricted.tier });
    const before = safeReadFile(executionFeedbackCandidatePath(row.candidate_id, restricted), {
      encoding: 'utf8',
    });
    expect(inspectExecutionFeedbackLearning(row.candidate_id, restricted).blockers[0]).toMatch(
      /^promotion_scope_not_preserved:/
    );
    expect(() => queueExecutionFeedbackLearning(row.candidate_id, restricted)).toThrow(
      /PROMOTION_SCOPE_UNSUPPORTED/
    );
    expect(
      safeReadFile(executionFeedbackCandidatePath(row.candidate_id, restricted), {
        encoding: 'utf8',
      })
    ).toBe(before);
    expect(safeExistsSync(memoryPromotionQueuePath(scope))).toBe(false);
    expect(listExecutionFeedbackCandidates(scope)).toEqual([]);
  });
  it('uses separate tenant and exact-scope files and never writes scoped proposals globally', () => {
    const row = candidate();
    expect(
      safeExistsSync(
        pathResolver.shared('runtime/distill-candidates/' + row.candidate_id + '.json')
      )
    ).toBe(false);
    expect(
      loadExecutionFeedbackCandidate(row.candidate_id, {
        ...scope,
        tenant_slug: 'synthetic-learning-b',
      })
    ).toBeNull();
    expect(
      listExecutionFeedbackCandidates({ ...scope, tenant_slug: 'synthetic-learning-b' })
    ).toEqual([]);
    expect(loadExecutionFeedbackCandidate(row.candidate_id)).toBeNull();
  });
  it('does not call a promoted label, file reference or merged usage aggregate proof', () => {
    const row = candidate();
    const review = queueExecutionFeedbackLearning(row.candidate_id, scope);
    updateMemoryPromotionCandidateStatus({
      candidateId: review.queue.candidate_id!,
      scope,
      status: 'promoted',
      promotedRef: 'knowledge/confidential/synthetic-learning-a/evolution/operations/fake.md',
      decidedBy: { kind: 'human', id: 'user:synthetic-fixture', role: 'owner' },
    });
    expect(inspectExecutionFeedbackLearning(row.candidate_id, scope)).toMatchObject({
      queue: { status: 'promoted' },
      promotion: { status: 'unverified' },
      retrieval: { status: 'unmeasured' },
      blockers: ['exact_publication_proof_unavailable'],
    });
  });

  it('never scans tenant queues for a legacy link or global candidates for scoped misses', () => {
    const row = candidate({
      tier: 'personal',
      scope: undefined,
      metadata: {
        improvement_kind: 'execution_feedback',
        learning_link: {
          candidate_id: 'MEM-FB-' + 'a'.repeat(32),
          source_digest: 'b'.repeat(64),
          queue_digest: 'c'.repeat(64),
        },
      },
    });
    const queueRead = vi.spyOn(queueModule, 'loadMemoryPromotionCandidate');
    expect(inspectExecutionFeedbackLearning(row.candidate_id).scope_disposition).toBe(
      'legacy_unscoped'
    );
    expect(queueRead).not.toHaveBeenCalled();
    const globalRead = vi.spyOn(registryModule, 'loadDistillCandidateRecord');
    expect(() => inspectExecutionFeedbackLearning(row.candidate_id, scope)).toThrow(/NOT_FOUND/);
    expect(globalRead).not.toHaveBeenCalled();
  });
  it('reports a recorded rejection without requiring approval ratification', () => {
    const row = candidate();
    const review = queueExecutionFeedbackLearning(row.candidate_id, scope);
    updateMemoryPromotionCandidateStatus({
      candidateId: review.queue.candidate_id!,
      scope,
      status: 'rejected',
      decidedBy: { kind: 'human', id: 'user:synthetic-reviewer', role: 'owner' },
    });
    expect(inspectExecutionFeedbackLearning(row.candidate_id, scope)).toMatchObject({
      queue: { status: 'rejected' },
      human_review: { status: 'rejected' },
      promotion: { status: 'none' },
      retrieval: { status: 'unmeasured' },
    });
  });

  it('rejects tampered queue payloads and links without replacing either record', () => {
    const row = candidate();
    const review = queueExecutionFeedbackLearning(row.candidate_id, scope);
    const queued = loadMemoryPromotionCandidate(review.queue.candidate_id!, scope)!;
    safeWriteFile(
      memoryPromotionQueuePath(scope),
      JSON.stringify({ ...queued, summary: 'Tampered fictional summary.' }) + '\n'
    );
    expect(inspectExecutionFeedbackLearning(row.candidate_id, scope).blockers).toContain(
      'queue_digest_or_scope_mismatch'
    );
    const before = safeReadFile(memoryPromotionQueuePath(scope), { encoding: 'utf8' });
    expect(() => queueExecutionFeedbackLearning(row.candidate_id, scope)).toThrow(/LINK_INVALID/);
    expect(safeReadFile(memoryPromotionQueuePath(scope), { encoding: 'utf8' })).toBe(before);
  });
  it('new feedback never edits a source that has already entered human review', () => {
    const first = materializeExecutionFeedbackCandidate({
      feedback: recordExecutionFeedback({
        scenario_id: 'synthetic-linked',
        intent_id: 'synthetic-linked',
        outcome: 'dissatisfied',
        correction: 'Share the fictional brief early.',
        scope,
      }),
    }).candidate!;
    ids.add(first.candidate_id);
    extraRoots.add(executionFeedbackScopeRoot(scope));
    queueExecutionFeedbackLearning(first.candidate_id, scope);
    const before = safeReadFile(executionFeedbackCandidatePath(first.candidate_id, scope), {
      encoding: 'utf8',
    });
    const next = materializeExecutionFeedbackCandidate({
      feedback: recordExecutionFeedback({
        scenario_id: 'synthetic-linked',
        intent_id: 'synthetic-linked',
        outcome: 'dissatisfied',
        correction: 'Name the fictional reviewer.',
        scope,
      }),
    }).candidate!;
    ids.add(next.candidate_id);
    expect(next.candidate_id).not.toBe(first.candidate_id);
    expect(
      safeReadFile(executionFeedbackCandidatePath(first.candidate_id, scope), { encoding: 'utf8' })
    ).toBe(before);
    expect(inspectExecutionFeedbackLearning(first.candidate_id, scope).queue.status).toBe('queued');
  });
});
