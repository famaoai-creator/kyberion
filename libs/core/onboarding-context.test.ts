import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  applyOnboardingContextBinding,
  applyOnboardingFirstWork,
  loadOnboardingContextBinding,
  loadOnboardingFirstWorkRecord,
  resolveOnboardingContext,
  resolveOnboardingFirstWork,
} from './onboarding-context.js';
import { writeTenantProfile } from './tenant-registry.js';
import { loadProjectRecord } from './project-registry.js';
import {
  safeExistsSync,
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
    },
    { rootDir, env: { KYBERION_CUSTOMER: 'acme-ai' } }
  );
}

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('onboarding context binding', () => {
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
    applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });

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
    applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });
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
    applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });

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
    applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });
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
    applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });

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

  it('bootstraps a project entirely under the supplied root', () => {
    seedFixture();
    applyOnboardingContextBinding({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });

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
