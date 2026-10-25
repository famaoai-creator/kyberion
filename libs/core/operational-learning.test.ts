import { describe, expect, it, vi } from 'vitest';

const enqueue = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn((): unknown[] => []));
const lock = vi.hoisted(() => vi.fn((_id: string, fn: () => unknown) => fn()));
const loadProfile = vi.hoisted(() => vi.fn(() => ({ organization_id: 'org-test' })));
vi.mock('./core.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('./organization/organization-profile.js', () => ({ loadOrganizationProfile: loadProfile }));
vi.mock('./organization/organization-operating-model.js', () => ({
  enqueueOrganizationLearningCandidate: enqueue,
  listOrganizationLearningCandidates: list,
}));
vi.mock('./foundation/lock-utils.js', () => ({ withLockSync: lock }));

import {
  enqueueOperationalLearningCandidateOnce,
  enqueueOperationalLearningSignal,
} from './operational-learning.js';

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

describe('enqueueOperationalLearningCandidateOnce (CD-12)', () => {
  const signal = {
    learningId: 'cdl-0000000000000002',
    dedupeKey: 'customer-decision-learning:revise_options:NFR/auth.method',
    signalId: 'cdl-0000000000000002',
    sourceType: 'customer_decision' as const,
    sourceRef: 'customer-decision-learning:revise_options:NFR/auth.method',
    title: 'Revise',
    summary: 'Revise the options.',
  };
  const earlier = (over: Record<string, unknown> = {}) => ({
    learning_id: 'cdl-0000000000000001',
    organization_id: 'org-test',
    status: 'rejected',
    created_at: '2026-10-18T00:00:00.000Z',
    metadata: { dedupe_key: signal.dedupeKey, evidence: { count: 3 } },
    ...over,
  });

  it('checks and writes under one lock per dedupe key; an earlier candidate in any status stands', () => {
    enqueue.mockClear();
    lock.mockClear();
    list.mockReturnValueOnce([earlier()]);
    // A rejected candidate with the same dedupe key (another date's id) stands.
    expect(enqueueOperationalLearningCandidateOnce(signal)).toEqual({
      learning_id: 'cdl-0000000000000001',
      created: false,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.calls[0][0]).toMatch(/^operational-learning-personal-shared-[a-f0-9]{24}$/u);
    expect(list.mock.calls[0][0]).toMatchObject({ organizationId: 'org-test', tier: 'personal' });
  });

  it('queues a new candidate (tagged with the dedupe key) when nothing stands or the evidence moved', () => {
    enqueue.mockClear();
    list.mockReturnValueOnce([]);
    expect(enqueueOperationalLearningCandidateOnce(signal)).toEqual({
      learning_id: signal.learningId,
      created: true,
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        learningId: signal.learningId,
        metadata: { dedupe_key: signal.dedupeKey },
      })
    );
    enqueue.mockClear();
    list.mockReturnValueOnce([earlier()]);
    expect(enqueueOperationalLearningCandidateOnce(signal, { supersedes: () => true })).toEqual({
      learning_id: signal.learningId,
      created: true,
    });
    // The same id never gets written twice, whatever supersedes says.
    enqueue.mockClear();
    list.mockReturnValueOnce([earlier({ learning_id: signal.learningId })]);
    expect(enqueueOperationalLearningCandidateOnce(signal, { supersedes: () => true })).toEqual({
      learning_id: signal.learningId,
      created: false,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
