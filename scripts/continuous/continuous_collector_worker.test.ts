import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  role: vi.fn(),
  charter: vi.fn(),
  selected: vi.fn(),
  attempt: vi.fn(),
  pipeline: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({ resolveRole: f.role }));
vi.mock('@agent/core/dot/dot-charter', () => ({ findDotCharter: f.charter }));
vi.mock('@agent/core/dot/dot-key-results', () => ({
  runAsDotCharter: (_charter: unknown, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/governance/operations-halt', () => ({
  getOperationsHaltState: () => ({ halted: false }),
}));
vi.mock('@agent/core/organization/organization-cadence', () => ({
  organizationCadenceLifecycle: () => 'active',
}));
vi.mock('@agent/core/scope-context', () => ({ resolveScopeResolution: f.selected }));
vi.mock('../lib/harness.js', () => ({ isDirectScript: () => false }));
vi.mock('../run_pipeline.js', () => ({
  executePipelineFile: f.pipeline,
  pipelinePayloadTrainingUse: () => 'no_training',
}));
vi.mock('./continuous_collector_state.js', () => ({ readCollectorAttempt: f.attempt }));

import { getReasoningPayloadScope } from '@agent/core/reasoning/reasoning-egress-scope';
import { continuousProcessContainment } from './continuous_owner_platform.js';
import { runCollectorWorker } from './continuous_collector_worker.js';

const scope = {
  tier: 'confidential',
  tenant_slug: 'acme',
  organization_id: 'org',
  project_id: 'project',
};
const ref = 'pipelines/collector.json';
const id = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.resetAllMocks();
  f.role.mockReturnValue('organization_operator');
  f.charter.mockReturnValue({
    charter: {
      scope,
      status: 'active',
      authority: {
        authority_role: 'organization_operator',
        allowed_pipelines: [ref],
      },
    },
  });
  f.selected.mockReturnValue({ scope });
  f.attempt.mockReturnValue({
    status: 'unconfirmed',
    pipeline_run_id: id,
    containment: continuousProcessContainment(process.pid, true),
  });
  f.pipeline.mockResolvedValue({ status: 'succeeded', results: [] });
});

describe('continuous collector worker', () => {
  it('runs headlessly under the exact tenant payload scope with the reserved journal ID', async () => {
    f.pipeline.mockImplementationOnce(async () => {
      expect(getReasoningPayloadScope()).toMatchObject({
        tier: 'confidential',
        tenant_slug: 'acme',
        training_use: 'no_training',
      });
      return { status: 'succeeded', results: [] };
    });
    await runCollectorWorker('dot', ref, id);
    expect(f.pipeline).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({
        context: { ...scope, collector_attempt_id: id },
        payloadScope: { tier: 'confidential', tenant_slug: 'acme' },
        hasHuman: false,
        journalRunId: id,
        collectorExecution: { dot_id: 'dot', attempt_id: id },
      })
    );
  });

  it('stops the execution fence when the personal owner changes', async () => {
    const initial = { tier: 'personal', organization_id: 'org', owner_nhi: 'first-owner' };
    const charter = {
      scope: initial,
      status: 'active',
      authority: {
        authority_role: 'organization_operator',
        allowed_pipelines: [ref],
      },
    };
    f.selected.mockReturnValue({ scope: initial });
    f.charter.mockReturnValue({ charter });
    f.pipeline.mockImplementationOnce(async (_ref, options) => {
      options.assertExecutionCurrent();
      f.charter.mockReturnValue({
        charter: { ...charter, scope: { ...initial, owner_nhi: 'new-owner' } },
      });
      options.assertExecutionCurrent();
      throw new Error('Execution was allowed after the owner changed');
    });
    await expect(runCollectorWorker('dot', ref, id)).rejects.toThrow(
      'authorization is no longer current'
    );
  });

  it('does not enter the Pipeline when this process is not the registered worker', async () => {
    f.attempt.mockReturnValue({
      status: 'unconfirmed',
      pipeline_run_id: id,
      containment: continuousProcessContainment(process.pid + 1, true),
    });
    await expect(runCollectorWorker('dot', ref, id)).rejects.toThrow('reserved Pipeline run');
    expect(f.pipeline).not.toHaveBeenCalled();
  });

  it('rejects a different tenant or a different reservation before entering the Pipeline', async () => {
    f.selected.mockReturnValueOnce({ scope: { ...scope, tenant_slug: 'other' } });
    await expect(runCollectorWorker('dot', ref, id)).rejects.toThrow('exact charter');
    await expect(runCollectorWorker('dot', ref, 'another-id')).rejects.toThrow('reserved Pipeline');
    expect(f.pipeline).not.toHaveBeenCalled();
  });
});
