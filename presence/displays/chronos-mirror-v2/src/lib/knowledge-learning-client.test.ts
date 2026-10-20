import { describe, expect, it } from 'vitest';
import {
  approvalWorkspaceQuery,
  curationRecoveryDigest,
  knowledgeCandidateHref,
  learningMutationConfirmed,
  learningPendingResolved,
  learningReviewHref,
  learningScopeSupported,
  parseLearningMutationReceipt,
  parseLearningPending,
} from './knowledge-learning-client';
import { parseKnowledgeResponse, type ClientKnowledgeCandidate } from './knowledge-response';
const digest = 'a'.repeat(64);
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'project-a',
};
const curation = {
  title: 'SOP title',
  summary: 'Summary',
  content: 'Exact reviewed steps',
  evidence_refs: ['trace:one'],
};
const candidate: ClientKnowledgeCandidate = {
  candidate_id: 'CAND-1',
  candidateKey: 'b'.repeat(64),
  status: 'queued',
  proposed_memory_kind: 'sop',
  summary: 'Original learning',
  evidence_refs: ['trace:one'],
  sensitivity_tier: 'confidential',
  source_ref: 'task_session:one',
  tenantSlug: 'acme',
  ratification_required: true,
  scope,
  curation,
  learning: { state: 'draft', payloadDigest: digest },
};
const publication = {
  version: 1 as const,
  candidate_id: candidate.candidate_id,
  scope,
  approved_payload_digest: digest,
  record_path: 'knowledge/confidential/acme/operations/CAND-1.json',
  markdown_path: 'knowledge/confidential/acme/operations/CAND-1.md',
  record_sha256: 'c'.repeat(64),
  markdown_sha256: 'd'.repeat(64),
};
const published: ClientKnowledgeCandidate = {
  ...candidate,
  status: 'promoted',
  promoted_ref: publication.markdown_path,
  learning: {
    state: 'published',
    payloadDigest: digest,
    approvalRef: 'terminal:approval-1',
    publication,
  },
};
const response = (rows: unknown[]) => ({
  ok: true,
  candidates: rows,
  tenantSlugs: ['acme'],
  accessRole: 'localadmin',
});

describe('scoped learning client projection and exact identity', () => {
  it('preserves scope, curation and verified publication without deriving authority', () => {
    expect(
      parseKnowledgeResponse(response([candidate, { ...published, candidateKey: 'e'.repeat(64) }]))
        ?.candidates
    ).toHaveLength(2);
    expect(parseKnowledgeResponse(response([published]))?.candidates[0]).toEqual(published);
  });
  it('requires composite keys and rejects collisions instead of selecting the first id', () => {
    expect(
      parseKnowledgeResponse(response([{ ...candidate, candidateKey: undefined }]))
    ).toBeUndefined();
    expect(parseKnowledgeResponse(response([candidate, candidate]))).toBeUndefined();
    expect(
      parseKnowledgeResponse(
        response([
          candidate,
          {
            ...candidate,
            candidateKey: 'c'.repeat(64),
            scope: { ...scope, project_id: 'project-b' },
          },
        ])
      )
    ).toBeDefined();
  });
  it.each([
    { ...published, learning: { ...published.learning, publication: undefined } },
    {
      ...published,
      learning: { ...published.learning, publication: { ...publication, candidate_id: 'another' } },
    },
    {
      ...published,
      learning: {
        ...published.learning,
        publication: { ...publication, scope: { ...scope, project_id: 'other' } },
      },
    },
    { ...published, learning: { ...published.learning, payloadDigest: 'f'.repeat(64) } },
    { ...candidate, learning: { state: 'approved', payloadDigest: digest } },
    {
      ...candidate,
      learning: {
        state: 'pending',
        payloadDigest: digest,
        approvalRef: 'https://evil.test/review',
      },
    },
    { ...candidate, scope: { ...scope, allowed_audience: [123] } },
    { ...candidate, curation: { ...curation, evidence_refs: {} } },
  ])('rejects malformed or contradictory scoped response', (row) => {
    expect(parseKnowledgeResponse(response([row]))).toBeUndefined();
  });
  it('matches both candidate key and id on a mutation receipt', () => {
    expect(parseLearningMutationReceipt({ ok: true, candidate }, candidate)).toEqual(candidate);
    expect(
      parseLearningMutationReceipt(
        { ok: true, candidate },
        { ...candidate, candidateKey: 'another-scope' }
      )
    ).toBeNull();
    expect(
      parseLearningMutationReceipt(
        { ok: true, candidate },
        { ...candidate, candidate_id: 'another-id' }
      )
    ).toBeNull();
    expect(parseLearningMutationReceipt({ ok: false, candidate }, candidate)).toBeNull();
  });
  it('never treats a promoted label as publication proof', () => {
    expect(
      learningMutationConfirmed('memory_publish_learning', { ...candidate, status: 'promoted' })
    ).toBe(false);
    expect(learningMutationConfirmed('memory_publish_learning', published)).toBe(true);
    expect(learningMutationConfirmed('memory_curate_candidate', candidate, curation)).toBe(true);
    expect(learningMutationConfirmed('memory_request_learning_approval', candidate)).toBe(false);
  });
  it.each([
    { owner_nhi: 'user:one' },
    { allowed_audience: ['user:one'] },
    { allowed_audience: [] },
    { promotion_policy: 'same_scope' as const },
  ])('preserves unsupported restrictions without enabling actions', (restriction) => {
    const restricted = { ...candidate, scope: { ...scope, ...restriction } };
    expect(learningScopeSupported(restricted)).toBe(false);
    expect(parseKnowledgeResponse(response([restricted]))?.candidates[0].scope).toEqual(
      restricted.scope
    );
  });
});

describe('read-only recovery hints', () => {
  it('retains unknown outcomes until the exact desired result is visible', async () => {
    expect(
      await learningPendingResolved(
        { action: 'memory_publish_learning', expectedPayloadDigest: digest },
        candidate
      )
    ).toBe(false);
    expect(
      await learningPendingResolved(
        { action: 'memory_publish_learning', expectedPayloadDigest: digest },
        published
      )
    ).toBe(true);
    expect(
      await learningPendingResolved(
        { action: 'memory_request_learning_approval', expectedPayloadDigest: digest },
        candidate
      )
    ).toBe(false);
    expect(
      await learningPendingResolved(
        { action: 'memory_request_learning_approval', expectedPayloadDigest: digest },
        {
          ...candidate,
          learning: {
            state: 'rejected',
            payloadDigest: digest,
            approvalRef: 'terminal:approval-1',
          },
        }
      )
    ).toBe(true);
  });
  it('stores no SOP text and can reconcile a same-content save after reload', async () => {
    const curationDigest = await curationRecoveryDigest(curation);
    const raw = JSON.stringify({
      action: 'memory_curate_candidate',
      expectedPayloadDigest: digest,
      curationDigest,
    });
    expect(raw).not.toContain(curation.content);
    const marker = parseLearningPending(raw)!;
    expect(await learningPendingResolved(marker, candidate)).toBe(true);
    expect(
      await learningPendingResolved(marker, {
        ...candidate,
        curation: { ...curation, content: 'Other content' },
      })
    ).toBe(false);
  });
  it('rejects corrupted recovery markers instead of dropping them to enable retry', () => {
    expect(() => parseLearningPending('{')).toThrow();
    expect(() =>
      parseLearningPending(JSON.stringify({ action: 'approve', expectedPayloadDigest: digest }))
    ).toThrow();
    expect(() =>
      parseLearningPending(
        JSON.stringify({ action: 'memory_publish_learning', expectedPayloadDigest: 'bad' })
      )
    ).toThrow();
    expect(parseLearningPending(null)).toBeNull();
  });
});

describe('canonical review links', () => {
  it('keeps mission-less terminal reviews addressable after a decision', () => {
    const href = learningReviewHref('terminal:approval-1', candidate.candidateKey, 'acme')!;
    const query = approvalWorkspaceQuery(href.slice(href.indexOf('?') + 1), 'acme');
    expect(query.get('requestId')).toBe('approval-1');
    expect(query.get('storageChannel')).toBe('terminal');
    expect(query.has('status')).toBe(false);
    expect(query.has('missionId')).toBe(false);
    expect(query.get('tenant')).toBe('acme');
  });
  it('preserves existing mission-admission links without guessing a storage channel', () => {
    const query = approvalWorkspaceQuery(
      'section=approvals&request=legacy-1&mission=MSN-LEGACY',
      'acme'
    );
    expect(query.get('missionId')).toBe('MSN-LEGACY');
    expect(query.has('status')).toBe(false);
    expect(query.has('requestId')).toBe(false);
    expect(query.has('storageChannel')).toBe(false);
    expect(query.get('tenant')).toBe('acme');
  });
  it('retains normal mission filtering but does not send an incomplete exact request pair', () => {
    expect(approvalWorkspaceQuery('mission=MSN-ONE').get('missionId')).toBe('MSN-ONE');
    expect(approvalWorkspaceQuery('request=unknown').has('requestId')).toBe(false);
  });
  it('uses pending-only for the normal queue and never accepts an arbitrary return URL', () => {
    expect(approvalWorkspaceQuery('', 'acme').get('status')).toBe('pending');
    expect(learningReviewHref('https://evil.test', candidate.candidateKey)).toBeNull();
    expect(knowledgeCandidateHref('https://evil.test', 'acme')).toMatch(
      /^\/\?section=knowledge&candidateKey=/
    );
  });
});
