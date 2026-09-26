import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadOperation: vi.fn(),
  loadState: vi.fn(),
  listRuns: vi.fn(),
  saveRun: vi.fn(),
  saveState: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('./organization-operating-model-operations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadOrganizationOperation: mocks.loadOperation,
  loadOrganizationOperationState: mocks.loadState,
  listOrganizationOperationRuns: mocks.listRuns,
  saveOrganizationOperationRun: mocks.saveRun,
  saveOrganizationOperationState: mocks.saveState,
}));

import {
  defaultOperationRunId,
  parseOrganizationRecordRunParams,
  recordOrganizationOperationRun,
  recordOrganizationOperationRunWithDefaults,
} from './organization-operation-run-recording.js';
import { OrganizationRecordExistsError } from './organization-operating-model-persistence.js';
import type { OrganizationOperationRecord } from './organization-operating-model.js';

// Any existing file under a scope root accepted by assertScopedOperationRunRef.
const EVIDENCE = 'knowledge/product/governance/organization-operations-runbook.md';

const operation = {
  operation_id: 'ringi-approval',
  organization_id: 'org-run',
  tier: 'confidential',
  tenant_slug: 'tenant-run',
  status: 'active',
  trigger: { kind: 'schedule', expression: '0 9 * * 1-5', timezone: 'Asia/Tokyo' },
  updated_at: '2026-09-01T00:00:00.000Z',
};

const baseParams = {
  organization_id: 'org-run',
  tier: 'confidential',
  tenant_slug: 'tenant-run',
  operation_id: 'ringi-approval',
  run_status: 'succeeded',
  result_summary: '稟議承認シナリオ完了',
  evidence_refs: [EVIDENCE],
};

describe('organization record_run params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadOperation.mockReturnValue(operation);
    mocks.loadState.mockReturnValue(null);
    mocks.listRuns.mockReturnValue([{ run_id: 'ringi-approval-20260925' }]);
    mocks.saveRun.mockReturnValue('run.json');
    mocks.saveState.mockReturnValue('state.json');
  });

  it('parses snake_case params and defaults apply to false', () => {
    expect(parseOrganizationRecordRunParams({ ...baseParams, evidence_refs: EVIDENCE })).toEqual({
      organizationId: 'org-run',
      tier: 'confidential',
      tenantSlug: 'tenant-run',
      operationId: 'ringi-approval',
      runStatus: 'succeeded',
      resultSummary: '稟議承認シナリオ完了',
      evidenceRefs: [EVIDENCE],
      apply: false,
    });
    expect(parseOrganizationRecordRunParams({ ...baseParams, apply: 'true' }).apply).toBe(true);
  });

  it.each([
    [{ run_status: 'started' }, /Invalid run status/],
    [{ tier: 'shared' }, /Invalid organization tier/],
    [{ result_summary: '' }, /requires result_summary/],
    [{ evidence_refs: { path: EVIDENCE } }, /evidence_refs must be an array/],
  ])('rejects invalid params %o', (override, message) => {
    expect(() => parseOrganizationRecordRunParams({ ...baseParams, ...override })).toThrow(message);
  });

  it('derives the next free run id and saves only when apply is set', () => {
    const now = new Date('2026-09-25T03:00:00.000Z');
    const dry = recordOrganizationOperationRunWithDefaults(
      parseOrganizationRecordRunParams(baseParams),
      now
    );
    expect(dry).toMatchObject({
      mode: 'dry_run',
      run: { run_id: 'ringi-approval-20260925-2', status: 'succeeded', evidence_refs: [EVIDENCE] },
      state: { status: 'succeeded' },
      saved_paths: [],
    });
    expect(mocks.saveRun).not.toHaveBeenCalled();

    const applied = recordOrganizationOperationRunWithDefaults(
      parseOrganizationRecordRunParams({ ...baseParams, apply: true, run_id: 'explicit-run' }),
      now
    );
    expect(applied.mode).toBe('apply');
    expect(applied.run.run_id).toBe('explicit-run');
    expect(applied.saved_paths).toEqual(['run.json', 'state.json']);
  });

  it('rejects an invalid run id and a schema-invalid run already in a dry run', () => {
    expect(() =>
      recordOrganizationOperationRunWithDefaults(
        parseOrganizationRecordRunParams({ ...baseParams, run_id: '../escape' })
      )
    ).toThrow(/Invalid run_id/);
    mocks.loadOperation.mockReturnValue({ ...operation, tenant_slug: 'Not_A_Tenant' });
    expect(() =>
      recordOrganizationOperationRunWithDefaults(parseOrganizationRecordRunParams(baseParams))
    ).toThrow(/Invalid organization operation run/);
    expect(mocks.saveRun).not.toHaveBeenCalled();
  });

  it('keeps default run ids within 64 characters, suffix included', () => {
    const longOperation = {
      ...operation,
      operation_id: `a${'b'.repeat(62)}c`,
    } as unknown as OrganizationOperationRecord;
    const now = new Date('2026-09-25T03:00:00.000Z');
    const first = defaultOperationRunId(longOperation, new Set(), now);
    const second = defaultOperationRunId(longOperation, new Set([first]), now);
    for (const id of [first, second]) {
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
    }
    expect(first.endsWith('-20260925')).toBe(true);
    expect(second.endsWith('-20260925-2')).toBe(true);
  });

  it('retries a defaulted run id with the next suffix when the run file already exists', () => {
    mocks.listRuns.mockReturnValue([]);
    mocks.saveRun
      .mockImplementationOnce(() => {
        throw new OrganizationRecordExistsError('organization operation run', 'run.json');
      })
      .mockReturnValue('run.json');
    const applied = recordOrganizationOperationRunWithDefaults(
      parseOrganizationRecordRunParams({ ...baseParams, apply: true }),
      new Date('2026-09-25T03:00:00.000Z')
    );
    expect(mocks.saveRun).toHaveBeenCalledTimes(2);
    expect(applied.run.run_id).toBe('ringi-approval-20260925-2');
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({
      action: 'organization.operation_run_recorded',
      tenantSlug: 'tenant-run',
      metadata: { run_id: 'ringi-approval-20260925-2', operation_id: 'ringi-approval' },
    });
  });

  it('fails an explicit run id whose run file already exists, without an audit entry', () => {
    mocks.listRuns.mockReturnValue([]);
    mocks.saveRun.mockImplementation(() => {
      throw new OrganizationRecordExistsError('organization operation run', 'run.json');
    });
    expect(() =>
      recordOrganizationOperationRun({
        organizationId: 'org-run',
        tier: 'confidential',
        tenantSlug: 'tenant-run',
        operationId: 'ringi-approval',
        runId: 'explicit-run',
        runStatus: 'succeeded',
        resultSummary: 'done',
        evidenceRefs: [EVIDENCE],
        apply: true,
      })
    ).toThrow(/Operation run already exists: explicit-run/);
    expect(mocks.saveState).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not audit a dry run', () => {
    recordOrganizationOperationRunWithDefaults(parseOrganizationRecordRunParams(baseParams));
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('fails closed when the operation does not exist', () => {
    mocks.loadOperation.mockReturnValue(null);
    expect(() =>
      recordOrganizationOperationRunWithDefaults(parseOrganizationRecordRunParams(baseParams))
    ).toThrow(/Organization operation not found/);
  });
});
