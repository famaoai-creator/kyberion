import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeMkdir, safeRmSync } from '../secure-io.js';
import { runInExecutionScope } from '../foundation/execution-scope.js';

const mocks = vi.hoisted(() => ({
  listStates: vi.fn(),
  listOperations: vi.fn(),
  loadOperation: vi.fn(),
  loadState: vi.fn(),
  listRuns: vi.fn(),
  saveRun: vi.fn(),
  saveState: vi.fn(),
  loadIncident: vi.fn(),
  saveIncident: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('./organization-operating-model-management.js', () => ({
  listOrganizationOperationalStates: mocks.listStates,
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
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: mocks.audit } }));
vi.mock('../lock-utils.js', () => ({
  withLock: (_id: string, fn: () => Promise<unknown>) => fn(),
}));

import {
  assertScopedCadenceExecution,
  listOrganizationScopes,
  normalizeCadenceTenant,
  runOrganizationOperationTick,
} from './organization-cadence.js';

/** Run `fn` as organization_operator bound to `tenantSlug` / `organizationId`. */
function asOperator<T>(
  tenantSlug: string | undefined,
  organizationId: string | undefined,
  fn: () => T
): T {
  return runInExecutionScope(
    {
      tenantBound: tenantSlug !== undefined,
      ...(tenantSlug ? { tenantSlug } : {}),
      ...(organizationId ? { organizationId } : {}),
      assumedRole: 'organization_operator',
      assumedPersona: null,
    },
    fn
  );
}

const operation = {
  operation_id: 'OP-1',
  organization_id: 'ORG-1',
  tier: 'public',
  status: 'active',
  owner_role: 'operator',
  updated_at: '2026-09-01T00:00:00.000Z',
  trigger: { kind: 'schedule', expression: '* * * * *', timezone: 'UTC' },
  execution_target: { kind: 'pipeline', ref: 'pipelines/example.json' },
  automation_boundary: { approval_required_actions: [], forbidden_actions: [] },
};

let rootDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  rootDir = path.join(process.cwd(), `active/shared/tmp/organization-cadence-test-${randomUUID()}`);
  safeMkdir(path.join(rootDir, 'active/organizations/public/shared'), { recursive: true });
  safeMkdir(path.join(rootDir, 'active/organizations/public/acme'), { recursive: true });
  mocks.listStates.mockImplementation(({ tenantSlug }: { tenantSlug: string }) => [
    {
      organization_id: tenantSlug === 'shared' ? 'ORG-1' : 'ORG-2',
      name: tenantSlug,
      status: 'active',
    },
  ]);
  mocks.listOperations.mockReturnValue([operation]);
  mocks.loadOperation.mockReturnValue(operation);
  mocks.loadState.mockReturnValue(null);
  mocks.listRuns.mockReturnValue([]);
  mocks.loadIncident.mockReturnValue(null);
});

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('normalizeCadenceTenant', () => {
  it('maps directory partitions and reserved scope names to no tenant', () => {
    for (const reserved of [
      'shared',
      'public',
      'confidential',
      'personal',
      ' Shared ',
      '',
      undefined,
    ]) {
      expect(normalizeCadenceTenant(reserved)).toBeUndefined();
    }
    expect(normalizeCadenceTenant('acme')).toBe('acme');
  });
});

describe('listOrganizationScopes', () => {
  it('queries the shared partition but never reports it as a tenant', () => {
    const scopes = listOrganizationScopes({ tier: 'public' }, rootDir);
    expect(mocks.listStates).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlug: 'shared' })
    );
    expect(scopes).toEqual([
      { organizationId: 'ORG-2', tier: 'public', tenantSlug: 'acme', name: 'acme' },
      { organizationId: 'ORG-1', tier: 'public', name: 'shared' },
    ]);
  });
});

describe('runOrganizationOperationTick', () => {
  it('executes untenanted organizations without the shared partition as tenant_slug', async () => {
    mocks.listRuns.mockImplementation(({ organizationId }: { organizationId: string }) =>
      organizationId === 'ORG-1'
        ? [
            {
              run_id: 'RUN-STALE',
              operation_id: 'OP-1',
              organization_id: 'ORG-1',
              tier: 'public',
              status: 'started',
              started_at: '2026-09-01T00:00:00.000Z',
              recorded_at: '2026-09-01T00:00:00.000Z',
            },
          ]
        : []
    );
    const executeOperation = vi.fn().mockResolvedValue(undefined);
    const report = await runOrganizationOperationTick(
      { tiers: ['public'], apply: true, rootDir, env: { KYBERION_PERSONA: 'sovereign' } },
      { executeOperation }
    );
    expect(report.failures).toEqual([]);
    expect(report.recovered).toEqual(['RUN-STALE']);
    expect(executeOperation).toHaveBeenCalledTimes(2);
    const shared = executeOperation.mock.calls.find(([input]) => input.organizationId === 'ORG-1');
    const tenanted = executeOperation.mock.calls.find(
      ([input]) => input.organizationId === 'ORG-2'
    );
    expect(shared?.[0]).not.toHaveProperty('tenantSlug');
    expect(tenanted?.[0]).toMatchObject({ tenantSlug: 'acme' });
    for (const [record] of [...mocks.saveRun.mock.calls, ...mocks.saveState.mock.calls]) {
      expect(record.tenant_slug).not.toBe('shared');
    }
    expect(mocks.saveState).toHaveBeenCalledWith(
      expect.not.objectContaining({ tenant_slug: expect.anything() })
    );
  });
});

describe('scoped cadence mode', () => {
  const scope = { tier: 'public' as const, tenantSlug: 'acme', organizationId: 'ORG-2' };

  it('refuses outside a governed execution scope', () => {
    expect(() => assertScopedCadenceExecution('operation tick', scope)).toThrow(
      /governed execution scope/
    );
  });

  it('refuses an execution scope bound to another tenant or organization', () => {
    expect(() =>
      asOperator('other', 'ORG-2', () => assertScopedCadenceExecution('operation tick', scope))
    ).toThrow(/bound to tenant 'other'/);
    expect(() =>
      asOperator(undefined, undefined, () => assertScopedCadenceExecution('standup', scope))
    ).toThrow(/bound to tenant '\(none\)'/);
    expect(() =>
      asOperator('acme', 'ORG-9', () => assertScopedCadenceExecution('retro', scope))
    ).toThrow(/bound to organization 'ORG-9'/);
  });

  it('ticks only the scoped organization without the sovereign persona and audits tick:scoped', async () => {
    const executeOperation = vi.fn().mockResolvedValue(undefined);
    const report = await asOperator('acme', 'ORG-2', () =>
      runOrganizationOperationTick(
        { scope, apply: true, rootDir, env: { KYBERION_PERSONA: 'worker' } },
        { executeOperation }
      )
    );
    expect(report.organizations).toBe(1);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(executeOperation.mock.calls[0][0]).toMatchObject({
      organizationId: 'ORG-2',
      tenantSlug: 'acme',
    });
    expect(mocks.listStates).toHaveBeenCalledWith(
      expect.objectContaining({ tenantSlug: 'acme', organizationId: 'ORG-2' })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'organization_operator',
        operation: 'tick:scoped',
        tenantSlug: 'acme',
      })
    );
  });

  it('never widens a scoped tick through an injected organization lister', async () => {
    const executeOperation = vi.fn().mockResolvedValue(undefined);
    const report = await asOperator('acme', undefined, () =>
      runOrganizationOperationTick(
        { scope, apply: false, rootDir },
        {
          executeOperation,
          listOrganizations: () => [
            { organizationId: 'ORG-2', tier: 'public', tenantSlug: 'acme' },
            { organizationId: 'ORG-X', tier: 'public', tenantSlug: 'other' },
          ],
        }
      )
    );
    expect(report.organizations).toBe(1);
  });

  it('refuses a scoped tick for a mismatched tenant before running anything', async () => {
    const executeOperation = vi.fn();
    await expect(
      asOperator('other', undefined, () =>
        runOrganizationOperationTick({ scope, apply: true, rootDir }, { executeOperation })
      )
    ).rejects.toThrow(/POLICY_VIOLATION/);
    expect(executeOperation).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('keeps the unscoped tick sovereign-only', async () => {
    await expect(
      asOperator('acme', 'ORG-2', () =>
        runOrganizationOperationTick(
          { apply: false, rootDir, env: { KYBERION_PERSONA: 'worker' } },
          { executeOperation: vi.fn() }
        )
      )
    ).rejects.toThrow(/requires KYBERION_PERSONA=sovereign/);
  });
});
