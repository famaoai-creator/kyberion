import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../../libs/core/foundation/execution-scope.js';
import type { KrMeasurementRow } from '@agent/core/organization/organization-objective-progress';
import type { OrganizationScopeRef } from '@agent/core/organization/organization-operation-tick';
import type { OrganizationTier } from '@agent/core/organization/organization-operating-model';
import { runInlineOrganizationKrMeasure } from './pipeline-domain-ops.js';

const STEP = { produces: 'kr_measure' } as never;
const row = (kr: string): KrMeasurementRow => ({
  scope: 'org',
  organization_id: 'ORG-1',
  objective_id: 'OBJ-1',
  kr_id: kr,
  value: 1,
  progress: 1,
  measured_at: '2026-11-21T00:00:00.000Z',
});

function asOperator<T>(tenantSlug: string | undefined, fn: () => T): T {
  return runInExecutionScope(
    {
      tenantBound: tenantSlug !== undefined,
      ...(tenantSlug ? { tenantSlug } : {}),
      assumedRole: 'organization_operator',
      assumedBaseRole: null,
    },
    fn
  );
}

afterEach(() => {
  delete process.env.KYBERION_BASE_ROLE;
});

describe('runInlineOrganizationKrMeasure', () => {
  it('sweeps every discovered organization under sovereign persona', async () => {
    process.env.KYBERION_BASE_ROLE = 'sovereign';
    const measure = vi.fn().mockResolvedValue([row('kr-1'), row('kr-2')]);
    const list = vi.fn((tier: OrganizationTier): OrganizationScopeRef[] =>
      tier === 'confidential'
        ? [{ organizationId: 'ORG-C', tier: 'confidential', tenantSlug: 'acme' }]
        : [{ organizationId: 'ORG-P', tier: 'public' }]
    );
    const result = await runInlineOrganizationKrMeasure(STEP, {}, {}, { measure, list });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledWith({
      organizationId: 'ORG-C',
      tier: 'confidential',
      tenantSlug: 'acme',
    });
    expect(result.kr_measure).toMatchObject({
      organizations: 2,
      measured: [
        { organization_id: 'confidential/acme/ORG-C', measurements: 2 },
        { organization_id: 'public/shared/ORG-P', measurements: 2 },
      ],
      failures: [],
    });
  });

  it('aggregates per-organization failures then fails the step', async () => {
    process.env.KYBERION_BASE_ROLE = 'sovereign';
    const measure = vi
      .fn()
      .mockRejectedValueOnce(new Error('ledger locked'))
      .mockResolvedValue([row('kr-1')]);
    const list = vi.fn((tier: OrganizationTier): OrganizationScopeRef[] =>
      tier === 'confidential'
        ? [
            { organizationId: 'ORG-A', tier: 'confidential', tenantSlug: 'acme' },
            { organizationId: 'ORG-B', tier: 'confidential', tenantSlug: 'acme' },
          ]
        : []
    );
    await expect(runInlineOrganizationKrMeasure(STEP, {}, {}, { measure, list })).rejects.toThrow(
      /core:organization_kr_measure: 1 organization\(s\) failed: confidential\/acme\/ORG-A: ledger locked/
    );
    // The remaining organization was still measured before the step failed.
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('refuses the unscoped sweep without the sovereign persona', async () => {
    process.env.KYBERION_BASE_ROLE = 'worker';
    const measure = vi.fn();
    await expect(
      runInlineOrganizationKrMeasure(STEP, {}, {}, { measure, list: () => [] })
    ).rejects.toThrow(/requires KYBERION_BASE_ROLE=sovereign/);
    expect(measure).not.toHaveBeenCalled();
  });

  it('measures only the scoped organization under a bound execution scope', async () => {
    const measure = vi.fn().mockResolvedValue([row('kr-1')]);
    const list = vi.fn((): OrganizationScopeRef[] => [
      { organizationId: 'ORG-1', tier: 'confidential', tenantSlug: 'acme' },
      { organizationId: 'ORG-X', tier: 'confidential', tenantSlug: 'acme' },
    ]);
    const ctx = {
      organization_id: 'ORG-1',
      tier: 'confidential',
      tenant_slug: 'acme',
    };
    const result = await asOperator('acme', () =>
      runInlineOrganizationKrMeasure(STEP, {}, ctx, { measure, list })
    );
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledWith({
      organizationId: 'ORG-1',
      tier: 'confidential',
      tenantSlug: 'acme',
    });
    expect(result.kr_measure).toMatchObject({ organizations: 1, failures: [] });
  });
});
