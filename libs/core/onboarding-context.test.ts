import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  applyOnboardingContextBinding,
  applyOnboardingFirstWork,
  loadOnboardingContextBinding,
  loadOnboardingFirstWorkRecord,
  readOptionalOnboardingFile,
  resolveOnboardingContext,
  resolveOnboardingFirstWork,
} from './onboarding-context.js';
import { writeTenantProfile } from './tenant-registry.js';
import { applyTenantActivation } from './tenant-activation.js';
import { loadProjectRecord } from './project-registry.js';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

const rootDir = path.join(process.cwd(), 'active/shared/tmp/onboarding-context-test');

function seedFixture(): void {
  safeMkdir(path.join(rootDir, 'customer', 'acme-ai', 'onboarding'), { recursive: true });
  safeWriteFile(
    path.join(rootDir, 'customer', 'acme-ai', 'organization-profile.json'),
    JSON.stringify({
      version: '1.0.0',
      organization_id: 'org-acme-ai',
      name: 'ACME AI',
      mission_defaults: { default_mission_class: 'general' },
      team_defaults: { default_team_template: 'default' },
      llm: { default_profile: 'default' },
    })
  );
  writeTenantProfile(
    {
      tenant_slug: 'acme-prod',
      tenant_id: 'acme-prod',
      display_name: 'ACME Production',
      status: 'active',
      assigned_role: 'owner',
      isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
    },
    { rootDir, env: { KYBERION_CUSTOMER: 'acme-ai' } }
  );
}

function bindAndActivate(): void {
  applyOnboardingContextBinding({
    customerSlug: 'acme-ai',
    tenantSlug: 'acme-prod',
    organizationId: 'org-acme-ai',
    ownerId: 'human:founder',
    rootDir,
  });
  applyTenantActivation({
    customerSlug: 'acme-ai',
    tenantSlug: 'acme-prod',
    organizationId: 'org-acme-ai',
    ownerId: 'human:founder',
    rootDir,
    accept: true,
    checks: {
      viewer_scope: true,
      nhi_provisioned: true,
      service_readiness: true,
      isolation_probe: true,
    },
    nhiIds: ['kyberion://agent/org-acme-ai/planner'],
    probeRefs: {
      viewer_scope: 'probe://viewer-scope/acme-prod/1',
      nhi_provisioned: 'probe://nhi/acme-prod/1',
      service_readiness: 'probe://services/acme-prod/1',
      isolation_probe: 'probe://isolation/acme-prod/1',
    },
  });
}

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('onboarding context binding', () => {
  it('reads only regular existing files for onboarding snapshots', () => {
    const filePath = path.join(rootDir, 'customer', 'acme-ai', 'onboarding', 'snapshot.json');
    const directoryPath = path.join(rootDir, 'customer', 'acme-ai', 'onboarding', 'snapshot-dir');
    safeWriteFile(filePath, '{"ok":true}', { mkdir: true });
    safeMkdir(directoryPath, { recursive: true });

    expect(readOptionalOnboardingFile(filePath, 'snapshot')).toBe('{"ok":true}');
    expect(readOptionalOnboardingFile(path.join(rootDir, 'missing.json'), 'snapshot')).toBe(
      undefined
    );
    expect(() => readOptionalOnboardingFile(directoryPath, 'snapshot')).toThrow(
      /must be a regular file/
    );
  });

  it('resolves customer, tenant, and organization without writing', () => {
    seedFixture();
    const result = resolveOnboardingContext({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      rootDir,
    });

    expect(result.mode).toBe('dry_run');
    expect(result.binding.customer_slug).toBe('acme-ai');
    expect(result.binding.tenant_slug).toBe('acme-prod');
    expect(result.binding.organization_id).toBe('org-acme-ai');
    expect(result.would_write.some((entry) => entry.endsWith('organization-context.json'))).toBe(
      true
    );
    expect(loadOnboardingContextBinding('acme-ai', rootDir)).toBeNull();
  });

  it('routes a routine first work without requiring a project', () => {
    seedFixture();
    bindAndActivate();

    const result = resolveOnboardingFirstWork({
      customerSlug: 'acme-ai',
      intent: 'Prepare the monthly operational report',
      rootDir,
    });

    expect(result.project_required).toBe(false);
    expect(result.resolution.work_shape).toBe('routine_operation');
    expect(result.resolution.management_unit).toBe('operation');
  });

  it('rejects an unregistered tenant before producing a binding', () => {
    safeMkdir(path.join(rootDir, 'customer', 'acme-ai'), { recursive: true });
    expect(() =>
      resolveOnboardingContext({
        customerSlug: 'acme-ai',
        tenantSlug: 'missing-tenant',
        organizationId: 'org-acme-ai',
        rootDir,
      })
    ).toThrow("Tenant 'missing-tenant' is not registered");
  });

  it('applies organization state and binding under the supplied root', () => {
    seedFixture();
    const result = applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });

    expect(result.saved_paths.every((filePath) => filePath.startsWith(rootDir))).toBe(true);
    expect(result.saved_paths).toContain(
      path.join(
        rootDir,
        'active/organizations/confidential/acme-prod/org-acme-ai/state/organization-state.json'
      )
    );
  });

  it('repairs a binding when its organization state was removed', () => {
    seedFixture();
    bindAndActivate();
    const statePath = path.join(
      rootDir,
      'active/organizations/confidential/acme-prod/org-acme-ai/state/organization-state.json'
    );
    safeUnlinkSync(statePath);

    const dryRun = resolveOnboardingContext({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });
    expect(dryRun.would_write).toContain(statePath);
    const repaired = applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });
    expect(repaired.reused).toBe(true);
    expect(safeExistsSync(statePath)).toBe(true);
  });

  it('rejects a first-work operation reference outside the organization context', () => {
    seedFixture();
    bindAndActivate();

    expect(() =>
      applyOnboardingFirstWork({
        customerSlug: 'acme-ai',
        intent: 'Prepare the monthly operational report',
        contextRefs: { operation_id: 'OP-FOREIGN' },
        accept: true,
        rootDir,
      })
    ).toThrow("Operation 'OP-FOREIGN' is not registered for the onboarding context");
  });

  it('blocks first work after the bound tenant is suspended', () => {
    seedFixture();
    bindAndActivate();
    writeTenantProfile(
      {
        tenant_slug: 'acme-prod',
        tenant_id: 'acme-prod',
        display_name: 'ACME Production',
        status: 'suspended',
        assigned_role: 'owner',
      },
      { rootDir, env: { KYBERION_CUSTOMER: 'acme-ai' } }
    );

    expect(() =>
      resolveOnboardingFirstWork({
        customerSlug: 'acme-ai',
        intent: 'Prepare the monthly operational report',
        rootDir,
      })
    ).toThrow(/suspended|active tenant/i);
  });

  it('connects a routine first work to an operation and persists the typed link', () => {
    seedFixture();
    bindAndActivate();

    const result = applyOnboardingFirstWork({
      customerSlug: 'acme-ai',
      intent: 'Prepare the monthly operational report',
      accept: true,
      rootDir,
    });

    expect(result.action).toBe('management_unit_connected');
    expect(result.saved_paths.some((filePath) => filePath.endsWith('/operation.json'))).toBe(true);
    expect(loadOnboardingFirstWorkRecord('acme-ai', rootDir)?.management_unit).toBe('operation');
    expect(loadOnboardingFirstWorkRecord('acme-ai', rootDir)?.work_item_id).toMatch(/^ONB-ITEM-/);
    expect(result.work_item?.context).toMatchObject({
      organization_id: 'org-acme-ai',
      tenant_slug: 'acme-prod',
      work_shape: 'routine_operation',
    });
  });

  it('fails closed when an onboarding binding is a directory instead of a record', () => {
    seedFixture();
    safeMkdir(path.join(rootDir, 'customer/acme-ai/onboarding/organization-context.json'), {
      recursive: true,
    });

    expect(() => loadOnboardingContextBinding('acme-ai', rootDir)).toThrow(/regular file/);
    expect(
      safeLstat(
        path.join(rootDir, 'customer/acme-ai/onboarding/organization-context.json')
      ).isDirectory()
    ).toBe(true);
  });

  it('bootstraps a project entirely under the supplied root', () => {
    seedFixture();
    bindAndActivate();

    const result = applyOnboardingFirstWork({
      customerSlug: 'acme-ai',
      intent: 'Build a new internal dashboard',
      accept: true,
      rootDir,
      bootstrapProject: {
        projectId: 'PRJ-ONB-ROOT-ISOLATION',
        name: 'Customer portal',
        summary: 'First onboarding project',
      },
    });

    expect(result.action).toBe('project_bootstrapped');
    expect(result.project?.project.project_id).toBe('PRJ-ONB-ROOT-ISOLATION');
    expect(loadProjectRecord('PRJ-ONB-ROOT-ISOLATION', { rootDir })?.tenant_slug).toBe('acme-prod');
    expect(result.project?.project.project_os_path?.startsWith(rootDir)).toBe(true);
    expect(result.saved_paths.every((filePath) => filePath.startsWith(rootDir))).toBe(true);
  });
});
