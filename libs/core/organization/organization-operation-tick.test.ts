import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listOperations: vi.fn(),
  loadOperation: vi.fn(),
  loadState: vi.fn(),
  listRuns: vi.fn(),
  saveRun: vi.fn(),
  saveState: vi.fn(),
  loadIncident: vi.fn(),
  saveIncident: vi.fn(),
}));
vi.mock('./organization-operating-model-operations.js', () => ({
  listOrganizationOperations: mocks.listOperations,
  loadOrganizationOperation: mocks.loadOperation,
  loadOrganizationOperationState: mocks.loadState,
  listOrganizationOperationRuns: mocks.listRuns,
  saveOrganizationOperationRun: mocks.saveRun,
  saveOrganizationOperationState: mocks.saveState,
  loadOrganizationIncident: mocks.loadIncident,
  saveOrganizationIncident: mocks.saveIncident,
}));
vi.mock('../lock-utils.js', () => ({
  withLock: (_id: string, fn: () => Promise<unknown>) => fn(),
}));

import { tickDueOrganizationOperations } from './organization-operation-tick.js';

const operation = (id: string, overrides: Record<string, unknown> = {}) => ({
  operation_id: id,
  organization_id: 'ORG-1',
  tier: 'public',
  status: 'active',
  owner_role: 'operator',
  updated_at: '2026-09-01T00:00:00.000Z',
  trigger: { kind: 'schedule', expression: '* * * * *', timezone: 'UTC' },
  execution_target: { kind: 'pipeline', ref: 'pipelines/example.json' },
  automation_boundary: { approval_required_actions: [], forbidden_actions: [] },
  ...overrides,
});

describe('tickDueOrganizationOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuns.mockReturnValue([]);
    mocks.loadState.mockReturnValue(null);
    mocks.loadIncident.mockReturnValue(null);
  });

  it('reports due work without executing on dry-run', async () => {
    mocks.listOperations.mockReturnValue([operation('OP-1')]);
    const executeOperation = vi.fn();
    const report = await tickDueOrganizationOperations(
      { organizationId: 'ORG-1', tier: 'public', apply: false },
      { executeOperation }
    );
    expect(report.mode).toBe('dry_run');
    expect(report.due).toHaveLength(1);
    expect(report.due[0].run_id).toMatch(/^scheduled-/);
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it('executes runnable operations and blocks those needing approval', async () => {
    mocks.listOperations.mockReturnValue([
      operation('OP-1'),
      operation('OP-2', {
        automation_boundary: { approval_required_actions: ['x'], forbidden_actions: [] },
      }),
    ]);
    const executeOperation = vi.fn().mockResolvedValue(undefined);
    const report = await tickDueOrganizationOperations(
      { organizationId: 'ORG-1', tier: 'public', apply: true },
      { executeOperation }
    );
    expect(report.due_count).toBe(2);
    expect(report.run_count).toBe(1);
    expect(report.blocked).toEqual([
      expect.objectContaining({ operation_id: 'OP-2', organization_id: 'ORG-1' }),
    ]);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'ORG-1', operationId: 'OP-1', tier: 'public' })
    );
  });

  it('collects failures without throwing and skips occurrences that already ran', async () => {
    mocks.listOperations.mockReturnValue([operation('OP-1')]);
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const first = await tickDueOrganizationOperations(
      { organizationId: 'ORG-1', tier: 'public', apply: true },
      { executeOperation: failing }
    );
    expect(first.failures).toEqual(['ORG-1/OP-1: boom']);
    mocks.listRuns.mockReturnValue([{ run_id: first.due[0].run_id, status: 'failed' }]);
    const second = await tickDueOrganizationOperations(
      { organizationId: 'ORG-1', tier: 'public', apply: true },
      { executeOperation: failing }
    );
    expect(second.due).toHaveLength(0);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('ticks every discovered organization when none is named', async () => {
    mocks.listOperations.mockReturnValue([operation('OP-1')]);
    const executeOperation = vi.fn().mockResolvedValue(undefined);
    const report = await tickDueOrganizationOperations(
      { tier: 'public', apply: true },
      {
        executeOperation,
        listOrganizations: () => [
          { organizationId: 'ORG-1', tier: 'public' },
          { organizationId: 'ORG-2', tier: 'public' },
        ],
      }
    );
    expect(report.organizations).toBe(2);
    expect(executeOperation).toHaveBeenCalledTimes(2);
  });

  it('marks an interrupted started run blocked and raises one incident', async () => {
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
    mocks.loadOperation.mockReturnValue(operation('OP-1'));
    const report = await tickDueOrganizationOperations(
      { organizationId: 'ORG-1', tier: 'public', apply: true },
      { executeOperation: vi.fn() }
    );
    expect(report.recovered).toEqual(['RUN-1']);
    expect(mocks.saveRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'RUN-1', status: 'blocked' })
    );
    expect(mocks.saveIncident).toHaveBeenCalledTimes(1);
  });
});
