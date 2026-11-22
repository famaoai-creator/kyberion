import { describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => {
  const scope = { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org' };
  return { scope, attempt: vi.fn(), selected: vi.fn(() => ({ scope })) };
});
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: (_role: string, callback: () => unknown) => callback(),
}));
vi.mock('@agent/core/scope-context', () => ({ resolveScopeResolution: f.selected }));
vi.mock('@agent/core/dot/dot-charter', () => ({
  findDotCharter: () => ({ charter: { scope: f.scope } }),
}));
vi.mock('@agent/core/dot/dot-key-results', () => ({}));
vi.mock('@agent/core/organization/continuous-operations-sources', () => ({}));
vi.mock('@agent/core/organization/continuous-operations', () => ({}));
vi.mock('@agent/core/organization/organization-cadence', () => ({
  readOrganizationCadenceState: () => ({ status: 'paused' }),
}));
vi.mock('./organization_cadence_reconcile.js', () => ({}));
vi.mock('./organization_write_approval.js', () => ({}));
vi.mock('../continuous/continuous_operations_cycle.js', () => ({
  runContinuousOperationsCycle: vi.fn(),
  runContinuousOperationsCycleFromRef: vi.fn(),
}));
vi.mock('../continuous/continuous_work_owner.js', () => ({ runContinuousManagedOwner: vi.fn() }));
vi.mock('../continuous/continuous_collector_state.js', () => ({
  COLLECTOR_NOT_STARTED_NEXT: { worker_missing: 'Build the repository' },
  readCollectorAttempt: f.attempt,
}));
vi.mock('../continuous/continuous_operations_config.js', () => ({
  loadContinuousOperationsConfig: () => ({
    scope: f.scope,
    loop_id: 'loop',
    dot_id: 'dot',
    sources: [{ source_id: 'metrics', kind: 'pipeline', pipeline_ref: 'pipelines/collect.json' }],
  }),
}));

import { runOrganizationContinuousStatus } from './organization_continuous_operations.js';

describe('continuous operations status during a pause', () => {
  it('shows recovery IDs without changing the organization execution state', async () => {
    f.attempt.mockReturnValue({
      status: 'unconfirmed',
      attempt_id: 'attempt',
      pipeline_run_id: 'run',
      started_at: '2026-11-22T00:00:00.000Z',
    });
    const print = vi.fn();
    await runOrganizationContinuousStatus(['--config', 'reviewed.json'], print);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_status: 'paused',
        continuous_operations: {
          status: 'awaiting_organization',
          collectors: [
            expect.objectContaining({
              source_id: 'metrics',
              status: 'unconfirmed',
              attempt_id: 'attempt',
              pipeline_run_id: 'run',
            }),
          ],
        },
      })
    );
  });

  it('projects the non-sensitive prelaunch reason and remediation', async () => {
    f.attempt.mockReturnValue({ status: 'not_started', reason_code: 'worker_missing' });
    const print = vi.fn();
    await runOrganizationContinuousStatus(['--config', 'reviewed.json'], print);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({
        continuous_operations: expect.objectContaining({
          collectors: [
            expect.objectContaining({
              status: 'not_started',
              reason_code: 'worker_missing',
              next: 'Build the repository',
            }),
          ],
        }),
      })
    );
  });

  it('rejects a different tenant before reading attempts', async () => {
    f.attempt.mockClear();
    f.selected.mockReturnValueOnce({ scope: { ...f.scope, tenant_slug: 'other' } });
    await expect(
      runOrganizationContinuousStatus(['--config', 'reviewed.json'], vi.fn())
    ).rejects.toThrow('matching tier');
    expect(f.attempt).not.toHaveBeenCalled();
  });
});
