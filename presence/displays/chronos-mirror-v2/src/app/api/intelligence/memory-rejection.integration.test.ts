import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withExecutionContextAsync } from '@agent/core/authority';
import { safeRmSync } from '@agent/core/secure-io';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  memoryPromotionCandidateKey,
} from '@agent/core/knowledge/memory-promotion-queue';
import { MEMORY_ACTION_HANDLERS } from './memory-actions';

vi.mock('@agent/core/governance/audit-chain', () => ({
  auditChain: { record: vi.fn(() => 'audit:synthetic') },
}));
const viewer = {
  role: 'localadmin' as const,
  source: 'token' as const,
  principalId: 'user:reviewer',
  tenantSlugs: ['review-tenant'],
  organizationIds: ['review-org'],
  projectIds: 'all' as const,
  tierAccess: ['public', 'confidential'] as ('public' | 'confidential')[],
  includeUntenanted: false,
};
let queuePath: string;
beforeEach(() => {
  queuePath = `active/shared/tmp/test-memory-rejection-${randomUUID()}.jsonl`;
  vi.stubEnv('KYBERION_MEMORY_QUEUE_PATH', queuePath);
});
afterEach(() => {
  safeRmSync(queuePath, { force: true });
  vi.unstubAllEnvs();
});

function fixture(domain: 'organization' | 'unclassified' = 'unclassified') {
  const candidate = createMemoryPromotionCandidate({
    candidateId: `MEM-REJECTION-${randomUUID()}`,
    sourceType: 'task_session',
    sourceRef: 'task_session:rejection-test',
    proposedMemoryKind: 'sop',
    knowledgeDomain: domain,
    summary: `A queued ${domain} SOP that an authorized reviewer declines.`,
    evidenceRefs: ['artifact:rejection-test'],
    sensitivityTier: 'confidential',
    scope: { tier: 'confidential', tenant_slug: 'review-tenant', organization_id: 'review-org' },
  });
  enqueueMemoryPromotionCandidate({ ...candidate, audit_ref: 'audit:synthetic' });
  return candidate;
}
async function chronos(
  candidate: ReturnType<typeof fixture>,
  action = 'memory_reject_candidate',
  extra = {}
) {
  return withExecutionContextAsync('chronos_gateway', () =>
    MEMORY_ACTION_HANDLERS[action](
      {
        action,
        candidateId: candidate.candidate_id,
        candidateKey: memoryPromotionCandidateKey(candidate),
        tenant: 'review-tenant',
        ...extra,
      },
      { context: viewer },
      action
    )
  );
}

describe('exact scoped SOP rejection with real queue and viewer selection', () => {
  it.each(['unclassified', 'organization'] as const)(
    'rejects a valid queued %s candidate without approving or publishing it',
    async (domain) => {
      const candidate = fixture(domain);
      expect((await chronos(candidate)).status).toBe(200);
      const stored = loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope)!;
      expect(stored.status).toBe('rejected');
      expect(stored).not.toHaveProperty('learning_approval');
      expect(stored).not.toHaveProperty('promoted_ref');
    }
  );
  it('denies wrong scope and wrong key without changing the queued record', async () => {
    const candidate = fixture();
    expect(
      (await chronos(candidate, 'memory_reject_candidate', { candidateKey: 'a'.repeat(64) })).status
    ).toBe(404);
    const other = { ...candidate, scope: { ...candidate.scope!, tenant_slug: 'other-tenant' } };
    enqueueMemoryPromotionCandidate({ ...other, candidate_id: 'MEM-OTHER-SCOPE' });
    expect((await chronos({ ...other, candidate_id: 'MEM-OTHER-SCOPE' })).status).toBe(404);
    expect(loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope)?.status).toBe(
      'queued'
    );
  });
  it('refuses legacy positive mutations for organization and unsupported scoped SOPs', async () => {
    for (const domain of ['organization', 'unclassified'] as const) {
      const candidate = fixture(domain);
      expect((await chronos(candidate, 'memory_approve_candidate')).status).toBe(409);
      expect((await chronos(candidate, 'memory_promote_candidate')).status).toBe(409);
      expect(loadMemoryPromotionCandidate(candidate.candidate_id, candidate.scope)?.status).toBe(
        'queued'
      );
    }
  });
});
