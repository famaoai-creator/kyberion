import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectEntityGovernanceReport,
  shouldFailEntityGovernance,
} from '../../scripts/check_entity_governance.js';
import { ENTITY_SCOPE_HIERARCHY } from './entity-scope.js';
import { createMission } from './mission-creation.js';
import {
  createManagedProject,
  createWorkItem,
  pathResolver,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
  saveOrganizationOperationalState,
  tenantProfilePath,
  withExecutionContext,
  writeTenantProfile,
} from '@agent/core';

const SUSPENDED_TENANT = 'eg-suspended-acceptance';
const FIXTURE_ROOT = pathResolver.sharedTmp('eg-governance-report-fixture');

describe('entity governance acceptance boundaries', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.KYBERION_ENTITY_GOVERNANCE = 'enforce';
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    process.env.KYBERION_SUDO = 'true';
  });

  afterEach(() => {
    safeUnlinkSync(tenantProfilePath(SUSPENDED_TENANT));
    safeRmSync(pathResolver.knowledge(`confidential/${SUSPENDED_TENANT}`), {
      recursive: true,
      force: true,
    });
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  function expectEntityDenied(tenantSlug: string, suffix: string): void {
    expect(() =>
      createManagedProject({
        project_id: `PRJ-EG-${suffix}`,
        name: 'Governance acceptance project',
        summary: 'Validation fixture',
        tier: 'confidential',
        tenant_slug: tenantSlug,
      })
    ).toThrow(/tenant|profile|suspended|archived/i);

    expect(() =>
      createWorkItem({
        itemId: `WI-EG-${suffix}`,
        title: 'Governance acceptance work item',
        description: 'Validation fixture',
        context: {
          tenant_slug: tenantSlug,
          project_id: `PRJ-EG-${suffix}`,
          work_shape: 'routine_operation',
        },
      })
    ).toThrow(/tenant|profile|suspended|archived/i);

    expect(() =>
      saveOrganizationOperationalState({
        organization_id: `ORG-EG-${suffix}`,
        name: 'Governance acceptance organization',
        tier: 'confidential',
        tenant_slug: tenantSlug,
        status: 'active',
        updated_at: new Date().toISOString(),
      })
    ).toThrow(/tenant|profile|suspended|archived/i);
  }

  it('uses one canonical scope order for every entity', () => {
    expect(ENTITY_SCOPE_HIERARCHY).toEqual([
      'tenant_slug',
      'organization_id',
      'project_id',
      'mission_id',
      'task_id',
      'session',
    ]);
  });

  it('keeps observed warnings non-fatal unless strict warning mode is requested', () => {
    const warningReport = { status: 'ok' as const, warnings: ['unregistered workspace'] };
    expect(shouldFailEntityGovernance(warningReport)).toBe(false);
    expect(shouldFailEntityGovernance(warningReport, true)).toBe(true);
    expect(shouldFailEntityGovernance({ status: 'drift', warnings: [] })).toBe(true);
  });

  it.each([
    ['unregistered', 'eg-unregistered-acceptance'],
    ['suspended', SUSPENDED_TENANT],
  ])(
    'rejects project, organization, and work-item writes for a %s tenant',
    (_label, tenantSlug) => {
      if (tenantSlug === SUSPENDED_TENANT) {
        withExecutionContext(
          'sovereign',
          () =>
            writeTenantProfile({
              tenant_slug: SUSPENDED_TENANT,
              display_name: 'EG suspended acceptance fixture',
              status: 'suspended',
              assigned_role: 'owner',
            }),
          'sovereign'
        );
      }
      expectEntityDenied(
        tenantSlug,
        tenantSlug.includes('unregistered') ? 'UNREGISTERED' : 'SUSPENDED'
      );
    }
  );

  it('rejects a mission write for both unregistered and suspended tenants', async () => {
    await expect(
      createMission({
        id: 'MSN-EG-UNREGISTERED-ACCEPTANCE',
        tier: 'confidential',
        tenantSlug: 'eg-unregistered-acceptance',
        rootDir: pathResolver.rootDir(),
      })
    ).rejects.toThrow(/tenant|profile/i);

    withExecutionContext(
      'sovereign',
      () =>
        writeTenantProfile({
          tenant_slug: SUSPENDED_TENANT,
          display_name: 'EG suspended acceptance fixture',
          status: 'suspended',
          assigned_role: 'owner',
        }),
      'sovereign'
    );
    await expect(
      createMission({
        id: 'MSN-EG-SUSPENDED-ACCEPTANCE',
        tier: 'confidential',
        tenantSlug: SUSPENDED_TENANT,
        rootDir: pathResolver.rootDir(),
      })
    ).rejects.toThrow(/tenant|suspended/i);
  });

  it('keeps the checker green for a clean scoped fixture', () => {
    safeMkdir(path.join(FIXTURE_ROOT, 'knowledge/product/governance'), { recursive: true });
    safeMkdir(path.join(FIXTURE_ROOT, 'schemas'), { recursive: true });
    safeWriteFile(
      path.join(FIXTURE_ROOT, 'knowledge/product/governance/security-policy.json'),
      JSON.stringify({
        tenant_scope: {
          protected_prefixes: ['active/missions/confidential/', 'active/projects/confidential/'],
        },
      })
    );
    safeWriteFile(
      path.join(FIXTURE_ROOT, 'knowledge/product/governance/storage-retention-catalog.json'),
      JSON.stringify({
        entries: [
          { path: 'active/shared/runtime/mesh-hub' },
          { path: 'active/shared/runtime/pipeline-runs' },
          { path: 'active/shared/runtime/run-graphs' },
        ],
      })
    );
    safeWriteFile(
      path.join(FIXTURE_ROOT, 'knowledge/product/schemas/governed-work-item.schema.json'),
      String(
        safeReadFile(
          pathResolver.rootResolve('knowledge/product/schemas/governed-work-item.schema.json'),
          {
            encoding: 'utf8',
          }
        )
      )
    );

    const report = withExecutionContext(
      'sovereign',
      () => collectEntityGovernanceReport(FIXTURE_ROOT),
      'sovereign'
    );
    expect(report.status).toBe('ok');
    expect(report.violations).toEqual([]);
    expect(report.retention.missing_declarations).toEqual([]);
    expect(report.git_boundaries.tracked_ignored).toEqual([]);
  });
});
