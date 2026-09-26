import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadOperation: vi.fn(),
  listRuns: vi.fn(),
  record: vi.fn(),
  guard: vi.fn(),
}));
vi.mock('@agent/core/organization-operating-model-operations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadOrganizationOperation: mocks.loadOperation,
  listOrganizationOperationRuns: mocks.listRuns,
}));
vi.mock('@agent/core/organization-operation-run-recording', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordOrganizationOperationRun: mocks.record,
}));
vi.mock('@agent/core/tier-guard', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateWritePermission: mocks.guard,
}));
vi.mock('@agent/core/scope-context', () => ({
  resolveScopeResolution: () => ({
    scope: { tier: 'confidential', tenant_slug: 'tenant-done', organization_id: 'org-done' },
  }),
}));

import { runOrganizationOperatingModelCli } from './organization_operating_model.js';

const runbookOperation = {
  operation_id: 'ringi-approval',
  organization_id: 'org-done',
  tier: 'confidential',
  tenant_slug: 'tenant-done',
  status: 'active',
  trigger: { kind: 'schedule', expression: '0 9 * * 1-5', timezone: 'Asia/Tokyo' },
  execution_target: {
    kind: 'runbook',
    ref: 'knowledge/confidential/tenant-done/operations/ringi-approval.md',
  },
};

describe('organization operation done', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockReturnValue({ allowed: true });
    mocks.loadOperation.mockReturnValue(runbookOperation);
    mocks.listRuns.mockReturnValue([]);
    mocks.record.mockImplementation((input: Record<string, unknown>) => ({
      run: { run_id: input.runId },
      state: {},
      saved_paths: [],
    }));
  });

  it('records an operator-attested run citing the runbook, scoped from the current scope', () => {
    runOrganizationOperatingModelCli([
      'operation',
      'done',
      '--operation-id',
      'ringi-approval',
      '--apply',
    ]);
    const input = mocks.record.mock.calls[0][0];
    expect(input).toMatchObject({
      organizationId: 'org-done',
      tier: 'confidential',
      tenantSlug: 'tenant-done',
      operationId: 'ringi-approval',
      runStatus: 'succeeded',
      evidenceRefs: ['knowledge/confidential/tenant-done/operations/ringi-approval.md'],
      apply: true,
    });
    expect(input.runId).toMatch(/^ringi-approval-\d{8}$/u);
  });

  it('suffixes the run id when the day already has a run', () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .replace(/-/gu, '');
    mocks.listRuns.mockReturnValue([{ run_id: `ringi-approval-${today}` }]);
    runOrganizationOperatingModelCli([
      'operation',
      'done',
      '--operation-id',
      'ringi-approval',
      '--dry-run',
    ]);
    expect(mocks.record.mock.calls[0][0].runId).toBe(`ringi-approval-${today}-2`);
  });

  it('refuses an --apply write the current persona may not make, before writing anything', () => {
    mocks.guard.mockReturnValue({ allowed: false, reason: 'Organization Confidential' });
    expect(() =>
      runOrganizationOperatingModelCli([
        'operation',
        'done',
        '--operation-id',
        'ringi-approval',
        '--apply',
      ])
    ).toThrow(/nothing was written/);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.guard.mock.calls[0][0]).toContain(
      'active/organizations/confidential/tenant-done/org-done/state/organization-state.json'
    );
  });

  it('does not run the write check for a dry run', () => {
    mocks.guard.mockReturnValue({ allowed: false, reason: 'denied' });
    runOrganizationOperatingModelCli([
      'operation',
      'done',
      '--operation-id',
      'ringi-approval',
      '--dry-run',
    ]);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.record.mock.calls[0][0].apply).toBe(false);
  });
});
