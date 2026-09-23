import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadOperation: vi.fn(),
  listOperations: vi.fn(),
  loadState: vi.fn(),
  listRuns: vi.fn(),
  saveRun: vi.fn(),
  saveState: vi.fn(),
  loadIncident: vi.fn(),
  saveIncident: vi.fn(),
  pipeline: vi.fn(),
}));
vi.mock('@agent/core/organization-operating-model-operations', () => ({
  loadOrganizationOperation: mocks.loadOperation,
  listOrganizationOperations: mocks.listOperations,
  loadOrganizationOperationState: mocks.loadState,
  listOrganizationOperationRuns: mocks.listRuns,
  saveOrganizationOperationRun: mocks.saveRun,
  saveOrganizationOperationState: mocks.saveState,
  loadOrganizationIncident: mocks.loadIncident,
  saveOrganizationIncident: mocks.saveIncident,
}));
vi.mock('@agent/core/path-resolver', () => ({ pathResolver: { rootDir: () => '/repo' } }));
vi.mock('@agent/core/organization-interventions', () => ({
  createOrganizationIncident: (input: Record<string, unknown>) => ({
    incident_id: input.incidentId,
    operation_id: input.operationId,
  }),
}));
vi.mock('@agent/core/secure-io', () => ({ safeExistsSync: () => true }));
vi.mock('@agent/core/lock-utils', () => ({
  withLock: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@agent/core/scope-context', () => ({
  resolveScopeResolution: () => ({ scope: { tier: 'public' } }),
}));
vi.mock('./run_pipeline.js', () => ({ executePipelineFile: mocks.pipeline }));

import {
  executeOrganizationOperation,
  tickOrganizationOperations,
} from './organization_operation_execute.js';

const args = [
  '--organization-id',
  'ORG-1',
  '--tier',
  'public',
  '--operation-id',
  'OP-1',
  '--run-id',
  'RUN-1',
];
const operation = {
  operation_id: 'OP-1',
  organization_id: 'ORG-1',
  tier: 'public',
  status: 'active',
  owner_role: 'operator',
  updated_at: '2026-09-01T00:00:00.000Z',
  trigger: { kind: 'manual' },
  execution_target: { kind: 'pipeline', ref: 'pipelines/example.json' },
  automation_boundary: { approval_required_actions: [], forbidden_actions: [] },
};

describe('organization operation execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadOperation.mockReturnValue(operation);
    mocks.listRuns.mockReturnValue([]);
    mocks.loadIncident.mockReturnValue(null);
  });

  it('keeps dry-run free of execution and writes', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await executeOrganizationOperation([...args, '--dry-run']);
      expect(mocks.pipeline).not.toHaveBeenCalled();
      expect(mocks.saveRun).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it('records a failed pipeline run and opens an incident', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.pipeline.mockRejectedValue(new Error('pipeline failed'));
    try {
      await expect(executeOrganizationOperation([...args, '--apply'])).rejects.toThrow(
        /Operation run failed/
      );
      expect(mocks.pipeline).toHaveBeenCalledWith(
        'pipelines/example.json',
        expect.objectContaining({
          payloadScope: expect.objectContaining({ tier: 'public' }),
        })
      );
      expect(mocks.saveRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'started' }));
      expect(mocks.saveRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
      expect(mocks.saveIncident).toHaveBeenCalledWith(
        expect.objectContaining({
          incident_id: expect.stringMatching(/^operation-/),
          operation_id: 'OP-1',
        })
      );
    } finally {
      output.mockRestore();
    }
  });

  it('reports due scheduled work without starting it on dry-run', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.listOperations.mockReturnValue([
      { ...operation, trigger: { kind: 'schedule', expression: '* * * * *', timezone: 'UTC' } },
    ]);
    mocks.loadState.mockReturnValue(null);
    try {
      await tickOrganizationOperations([
        '--organization-id',
        'ORG-1',
        '--tier',
        'public',
        '--dry-run',
      ]);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('scheduled-'));
      expect(mocks.pipeline).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it('marks an interrupted started run blocked and raises an incident on tick', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.listRuns.mockReturnValue([
      {
        run_id: 'RUN-1',
        operation_id: 'OP-1',
        status: 'started',
        organization_id: 'ORG-1',
        tier: 'public',
        started_at: '2026-09-01T00:00:00.000Z',
        recorded_at: '2026-09-01T00:00:00.000Z',
      },
    ]);
    mocks.listOperations.mockReturnValue([]);
    mocks.loadState.mockReturnValue({ status: 'running', due_status: 'not_scheduled' });
    try {
      await tickOrganizationOperations([
        '--organization-id',
        'ORG-1',
        '--tier',
        'public',
        '--apply',
      ]);
      expect(mocks.saveRun).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'blocked', run_id: 'RUN-1' })
      );
      expect(mocks.saveIncident).toHaveBeenCalledWith(
        expect.objectContaining({ operation_id: 'OP-1' })
      );
      expect(mocks.pipeline).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });
});
