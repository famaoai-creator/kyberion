import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the organization profile is stubbed; the operating model, the store
// grant and the owner-partitioned memory queue are the real ones.
vi.mock('../organization/organization-profile.js', () => ({
  loadOrganizationProfile: () => ({ organization_id: 'org-owner-test' }),
}));

import { safeRmSync } from '../secure-io.js';
import {
  memoryPromotionQueuePath,
  listMemoryPromotionCandidates,
} from './memory-promotion-queue.js';
import { enqueueOperationalLearningSignal } from './operational-learning.js';

const cleanup = new Set<string>();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of cleanup) safeRmSync(dir, { recursive: true, force: true });
  cleanup.clear();
});

describe('operational learning — installed owner on the real queue', () => {
  it('lands a personal candidate in the named owner partition with no KYBERION_NHI_ID', () => {
    vi.stubEnv('KYBERION_NHI_ID', '');
    vi.stubEnv('KYBERION_MEMORY_QUEUE_PATH', '');
    const ownerNhi = `kyberion://agent/_/_/owner-${randomUUID()}`;
    const scope = { tier: 'personal', owner_nhi: ownerNhi } as const;
    cleanup.add(path.dirname(path.dirname(memoryPromotionQueuePath(scope))));

    const learningId = enqueueOperationalLearningSignal(
      {
        signalId: `owner-e2e-${randomUUID().slice(0, 8)}`,
        sourceType: 'runtime_signal',
        sourceRef: 'learning-signal:test-source:owner-e2e',
        title: 'Recurring test-source: owner e2e',
        summary: 'Personal candidate owned by the installed runtime.',
      },
      { ownerNhi }
    );

    expect(learningId).toMatch(/-personal-shared$/);
    const rows = listMemoryPromotionCandidates(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: expect.objectContaining({ owner_nhi: ownerNhi }) });
  });
});
