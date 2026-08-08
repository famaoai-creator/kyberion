import { describe, expect, it, vi } from 'vitest';

const enqueue = vi.hoisted(() => vi.fn());
const loadProfile = vi.hoisted(() => vi.fn(() => ({ organization_id: 'org-test' })));
vi.mock('./core.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./organization-profile.js', () => ({ loadOrganizationProfile: loadProfile }));
vi.mock('./organization-operating-model.js', () => ({
  enqueueOrganizationLearningCandidate: enqueue,
}));

import { enqueueOperationalLearningSignal } from './operational-learning.js';

describe('operational learning signals (LC-16)', () => {
  it('queues a deterministic daily candidate from a machine finding', () => {
    enqueue.mockClear();
    const learningId = enqueueOperationalLearningSignal(
      {
        signalId: 'scheduler-failed-schedules',
        sourceType: 'routine_exception',
        sourceRef: 'baseline:failed-schedules:2026-08-08',
        title: 'Schedule review',
        summary: 'A schedule needs review.',
        evidenceRefs: ['schedule:daily'],
      },
      { now: new Date('2026-08-08T12:00:00.000Z') }
    );

    expect(learningId).toBe('ops-2026-08-08-scheduler-failed-schedules-personal-shared');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        learningId,
        organizationId: 'org-test',
        sourceType: 'routine_exception',
        targetKind: 'sop_candidate',
        tier: 'personal',
      })
    );
  });

  it('does not downgrade confidential signals without tenant scope', () => {
    enqueue.mockClear();
    const learningId = enqueueOperationalLearningSignal({
      signalId: 'confidential-finding',
      sourceType: 'routine_exception',
      sourceRef: 'test:confidential',
      title: 'Confidential review',
      summary: 'Needs a tenant.',
      tier: 'confidential',
    });

    expect(learningId).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
