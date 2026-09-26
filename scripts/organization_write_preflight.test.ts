import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  enqueue: vi.fn(),
  buildLearning: vi.fn(),
  guard: vi.fn(),
}));
vi.mock('@agent/core/organization-operating-model-management', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reconcileOrganizationState: mocks.reconcile,
}));
vi.mock('@agent/core/organization-operating-model-operations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueOrganizationLearningCandidate: mocks.enqueue,
  buildOrganizationLearningCandidate: mocks.buildLearning,
}));
vi.mock('@agent/core/tier-guard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateWritePermission: mocks.guard,
}));
vi.mock('@agent/core/scope-context', () => ({
  resolveScopeResolution: () => ({
    scope: { tier: 'confidential', tenant_slug: 'tenant-pre', organization_id: 'org-pre' },
  }),
}));

import { runOrganizationOperatingModelCli } from './organization_operating_model.js';

const LEARNING_ARGS = [
  'learning',
  'enqueue',
  '--tier',
  'confidential',
  '--learning-id',
  'lesson-1',
  '--source-type',
  'incident',
  '--source-ref',
  'incident-1',
  '--title',
  'Lesson',
  '--summary',
  'Summary',
  '--target-kind',
  'runbook',
];

describe('organization write preflight for reconcile and learning enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReturnValue({ allowed: false, reason: 'Organization Confidential' });
    mocks.reconcile.mockReturnValue({ applied: false });
    mocks.enqueue.mockReturnValue({ learning_id: 'lesson-1' });
    mocks.buildLearning.mockReturnValue({ learning_id: 'lesson-1' });
  });

  it('refuses reconcile --apply before reconciling when the write is not permitted', () => {
    expect(() => runOrganizationOperatingModelCli(['reconcile', '--apply'])).toThrow(
      /nothing was written/
    );
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.guard.mock.calls[0][0]).toContain(
      'active/organizations/confidential/tenant-pre/org-pre/state/organization-state.json'
    );
  });

  it('keeps the read-only reconcile default without a write check', () => {
    runOrganizationOperatingModelCli(['reconcile']);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.reconcile.mock.calls[0][0].apply).toBe(false);
  });

  it('refuses learning enqueue --apply before enqueueing when the write is not permitted', () => {
    expect(() => runOrganizationOperatingModelCli([...LEARNING_ARGS, '--apply'])).toThrow(
      /nothing was written/
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('lets learning enqueue --dry-run build without a write check', () => {
    runOrganizationOperatingModelCli([...LEARNING_ARGS, '--dry-run']);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.buildLearning).toHaveBeenCalledTimes(1);
  });
});
