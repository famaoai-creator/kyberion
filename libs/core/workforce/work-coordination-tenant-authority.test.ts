import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { tenantProfilePath, writeTenantProfile } from '../organization/tenant-registry.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeUnlinkSync } from '../secure-io.js';
import {
  createWorkItem,
  createWorkItemIfAbsent,
  importExternalWorkItem,
} from './work-coordination.js';

// The store fence assumes infrastructure_sentinel, which may not read the
// personal-tier tenant registry. Tenant validation must run under the caller's
// authority (onboarding-flow.md Step 11: `pnpm work create-item --tenant-slug`).
const TENANT = 'wc-authority-tenant';
const ENV_KEYS = [
  'KYBERION_ENTITY_GOVERNANCE',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'KYBERION_SUDO',
  'KYBERION_TENANT',
] as const;

describe('work item tenant validation authority', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.KYBERION_ENTITY_GOVERNANCE = 'enforce';
    process.env.KYBERION_PERSONA = 'sovereign';
    delete process.env.MISSION_ROLE;
    delete process.env.KYBERION_SUDO;
    delete process.env.KYBERION_TENANT;
    withExecutionContext(
      'sovereign',
      () =>
        writeTenantProfile({
          tenant_slug: TENANT,
          display_name: 'Work coordination authority fixture',
          status: 'active',
          assigned_role: 'owner',
        }),
      'sovereign'
    );
  });

  afterEach(() => {
    withExecutionContext(
      'sovereign',
      () => {
        safeUnlinkSync(tenantProfilePath(TENANT));
        // writeTenantProfile also creates the tenant's confidential knowledge root.
        safeRmSync(pathResolver.knowledge(`confidential/${TENANT}`), {
          recursive: true,
          force: true,
        });
      },
      'sovereign'
    );
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('creates a tenant-scoped work item for a sovereign caller without SUDO', () => {
    const itemId = `WI-WC-AUTH-${process.pid}-${Date.now()}`;
    const item = createWorkItem({
      itemId,
      title: 'tenant scoped item',
      description: 'validated under the caller authority',
      projectId: 'PRJ-WC-AUTH',
      context: {
        tenant_slug: TENANT,
        organization_id: TENANT,
        project_id: 'PRJ-WC-AUTH',
        mission_id: 'MSN-WC-AUTH',
        work_shape: 'solution_project',
      },
    });
    expect(item.context?.tenant_slug).toBe(TENANT);
    expect(
      createWorkItemIfAbsent({
        itemId,
        title: 'tenant scoped item',
        description: 'validated under the caller authority',
        projectId: 'PRJ-WC-AUTH',
        context: item.context,
      }).item_id
    ).toBe(itemId);
  });

  it('still rejects an unregistered tenant, for the registry reason', () => {
    let failure: unknown;
    try {
      createWorkItem({
        title: 'unregistered tenant item',
        description: 'must be rejected',
        context: { tenant_slug: 'wc-authority-missing', work_shape: 'routine_operation' },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toMatch(/ROLE_VIOLATION/);
    expect(String((failure as Error).message)).toMatch(/tenant/i);
  });

  it('re-syncs an imported item after its tenant is suspended, but rejects new imports', () => {
    const sourceRef = `github:wc-auth/${process.pid}-${Date.now()}`;
    const imported = importExternalWorkItem({
      source: 'github',
      sourceRef,
      title: 'imported item',
      description: 'from an external tracker',
      status: 'backlog',
      context: { tenant_slug: TENANT, project_id: 'PRJ-WC-AUTH', work_shape: 'routine_operation' },
    });
    expect(imported.context?.tenant_slug).toBe(TENANT);
    withExecutionContext(
      'sovereign',
      () =>
        writeTenantProfile({
          tenant_slug: TENANT,
          display_name: 'Work coordination authority fixture',
          status: 'suspended',
          assigned_role: 'owner',
        }),
      'sovereign'
    );
    const resynced = importExternalWorkItem({
      source: 'github',
      sourceRef,
      title: 'imported item (renamed upstream)',
      description: 'from an external tracker',
      status: 'backlog',
      context: { tenant_slug: TENANT, project_id: 'PRJ-WC-AUTH', work_shape: 'routine_operation' },
    });
    expect(resynced.item_id).toBe(imported.item_id);
    expect(resynced.title).toBe('imported item (renamed upstream)');
    expect(() =>
      importExternalWorkItem({
        source: 'github',
        sourceRef: `${sourceRef}-new`,
        title: 'new item',
        description: 'from an external tracker',
        status: 'backlog',
        context: {
          tenant_slug: TENANT,
          project_id: 'PRJ-WC-AUTH',
          work_shape: 'routine_operation',
        },
      })
    ).toThrow(/suspended|tenant/i);
  });
});
