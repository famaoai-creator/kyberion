import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  curate: vi.fn(),
  request: vi.fn(),
  publish: vi.fn(),
  update: vi.fn(),
  promote: vi.fn(),
}));
vi.mock('@agent/core/knowledge/scoped-learning-workflow', () => ({
  curateScopedLearningCandidate: mocks.curate,
  requestScopedLearningCandidateApproval: mocks.request,
  publishScopedLearningCandidate: mocks.publish,
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', () => ({
  updateMemoryPromotionCandidateStatus: mocks.update,
  memoryPromotionCandidateKey: () => 'b'.repeat(64),
}));
vi.mock('@agent/core/knowledge/memory-promotion-workflow', () => ({
  promoteMemoryCandidateToKnowledge: mocks.promote,
}));
vi.mock('../../../lib/memory-candidate-selection', () => ({
  resolveMemoryCandidateForViewer: mocks.resolve,
  MemoryCandidateAmbiguityError: class extends Error {},
}));
vi.mock('../../../lib/knowledge-candidate-projection', () => ({
  projectKnowledgeCandidate: (candidate: unknown) => candidate,
}));
import { MEMORY_ACTION_HANDLERS } from './memory-actions';
import { MemoryCandidateAmbiguityError } from '../../../lib/memory-candidate-selection';
import { parseChronosIntelligenceInput } from './intelligence-input';
const scope = {
  tier: 'confidential',
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
};
const row = {
  candidate_id: 'MEM-ACTION',
  scope,
  proposed_memory_kind: 'sop',
  knowledge_domain: 'organization',
  status: 'queued',
  ratification_required: true,
};
const digest = 'a'.repeat(64),
  key = 'b'.repeat(64);
const curation = {
  title: 'Scoped SOP',
  summary: 'summary',
  content: 'Step one\nStep two',
  evidence_refs: ['artifact:one'],
};
const viewer = {
  context: {
    role: 'localadmin' as const,
    source: 'token' as const,
    principalId: 'user:server',
    tenantSlugs: ['acme'],
  },
};
const run = (action: string, extra = {}) =>
  MEMORY_ACTION_HANDLERS[action](
    {
      action,
      candidateId: row.candidate_id,
      candidateKey: key,
      expectedPayloadDigest: digest,
      tenant: 'acme',
      ...extra,
    },
    viewer,
    action
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue(row);
  for (const fn of [mocks.curate, mocks.request, mocks.publish, mocks.promote])
    fn.mockReturnValue({ candidate: row });
});
describe('scoped learning action adapter', () => {
  it('curates only the exact visible server scope and revision', async () => {
    expect((await run('memory_curate_candidate', { curation })).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith({
      candidateId: row.candidate_id,
      candidateKey: key,
      viewer: viewer.context,
      requestedTenant: 'acme',
    });
    expect(mocks.curate).toHaveBeenCalledWith({
      candidateId: row.candidate_id,
      scope,
      expectedPayloadDigest: digest,
      curation,
    });
  });
  it('opens review with the server requester, never a human label from the body', async () => {
    await run('memory_request_learning_approval');
    expect(mocks.request).toHaveBeenCalledWith({
      candidateId: row.candidate_id,
      scope,
      expectedPayloadDigest: digest,
      requester: { requestedBy: 'user:server', actorId: 'user:server' },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('publishes through the complete shared facade, not a raw file writer', async () => {
    await run('memory_publish_learning');
    expect(mocks.publish).toHaveBeenCalledWith({
      candidateId: row.candidate_id,
      scope,
      expectedPayloadDigest: digest,
      executionRole: 'chronos_gateway',
    });
    expect(mocks.promote).not.toHaveBeenCalled();
  });
  it.each(['memory_approve_candidate', 'memory_promote_candidate'])(
    'refuses scoped SOP shortcut %s',
    async (action) => {
      const response = await run(action);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ outcome: 'not_applied' });
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.promote).not.toHaveBeenCalled();
    }
  );
  it.each(['organization', 'unclassified'])(
    'allows exact scoped %s candidate rejection without granting approval or publication',
    async (knowledge_domain) => {
      const candidate = { ...row, knowledge_domain };
      mocks.resolve.mockReturnValue(candidate);
      mocks.update.mockReturnValue({ ...candidate, status: 'rejected' });
      expect(
        (await run('memory_reject_candidate', { expectedPayloadDigest: undefined })).status
      ).toBe(200);
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: row.candidate_id,
          scope,
          status: 'rejected',
          expectedStatus: 'queued',
        })
      );
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.promote).not.toHaveBeenCalled();
    }
  );
  it.each([undefined, 'a'.repeat(64)])(
    'rejects missing or mismatched scoped rejection key %s',
    async (candidateKey) => {
      expect((await run('memory_reject_candidate', { candidateKey })).status).toBe(409);
      expect(mocks.update).not.toHaveBeenCalled();
    }
  );
  it('does not route unclassified scoped SOP positive mutations through legacy or governed publication', async () => {
    mocks.resolve.mockReturnValue({ ...row, knowledge_domain: 'unclassified' });
    for (const action of [
      'memory_approve_candidate',
      'memory_promote_candidate',
      'memory_publish_learning',
    ])
      expect((await run(action)).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('forwards legacy scope unchanged without changing legacy authority', async () => {
    const legacy = { ...row, proposed_memory_kind: 'heuristic' };
    mocks.resolve.mockReturnValue(legacy);
    mocks.update.mockReturnValue(legacy);
    await run('memory_approve_candidate');
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: row.candidate_id, scope, status: 'approved' })
    );
  });
  it('returns not-applied for absent or ambiguous selection without calling the facade', async () => {
    mocks.resolve.mockReturnValue(null);
    expect((await run('memory_publish_learning')).status).toBe(404);
    mocks.resolve.mockImplementation(() => {
      throw new MemoryCandidateAmbiguityError('ambiguous');
    });
    const response = await run('memory_publish_learning');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ outcome: 'not_applied' });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('does not mislabel a partial publication error as definitely not applied', async () => {
    mocks.publish.mockRejectedValue(
      new Error('[LEARNING_PUBLICATION_INVALID] interrupted at /private/tenant/secret-path')
    );
    const response = await run('memory_publish_learning');
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).not.toHaveProperty('outcome');
    expect(JSON.stringify(payload)).not.toContain('/private/tenant/secret-path');
  });
});
describe('strict scoped learning inputs', () => {
  const valid = {
    action: 'memory_curate_candidate',
    candidateId: row.candidate_id,
    candidateKey: key,
    expectedPayloadDigest: digest,
    curation,
  };
  it('accepts bounded multiline curation', () => {
    expect(parseChronosIntelligenceInput(valid)).toEqual(valid);
  });
  it.each([
    { scope },
    { decidedBy: 'user:forged' },
    { approvalRef: 'terminal:forged' },
    { knowledgeDomain: 'product' },
  ])('rejects client authority field %j', (extra) => {
    expect(() => parseChronosIntelligenceInput({ ...valid, ...extra })).toThrow();
  });
  it.each([
    { candidateKey: '' },
    { expectedPayloadDigest: 'guess' },
    { curation: { ...curation, authority: 'all' } },
    { curation: { ...curation, evidence_refs: [] } },
    { curation: { ...curation, content: 'bad\0text' } },
  ])('rejects malformed action %j', (change) => {
    expect(() => parseChronosIntelligenceInput({ ...valid, ...change })).toThrow();
  });
});
