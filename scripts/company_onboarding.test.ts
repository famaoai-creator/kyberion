import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  writeTenantProfile,
} from '@agent/core';
import { onboardAiCompany } from './company_onboarding.js';

const rootDir = pathResolver.sharedTmp('company-onboarding-test');

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('AI company onboarding', () => {
  it('dry-runs without writing and shows the complete next path', () => {
    const result = onboardAiCompany({
      vertical: 'saas-product-company',
      slug: 'acme-ai',
      companyName: 'ACME AI',
      firstWork: 'Define the first customer outcome and launch plan',
      rootDir,
      dryRun: true,
    });
    expect(result.status).toBe('planned');
    expect(result.writtenFiles).toHaveLength(0);
    expect(result.nextCommands).toContain('pnpm setup:report --persona first-time-user');
  });

  it('materializes accountability, workforce, boundaries, and first work', () => {
    const result = onboardAiCompany({
      vertical: 'saas-product-company',
      slug: 'acme-ai',
      companyName: 'ACME AI',
      firstWork: 'Define the first customer outcome and launch plan',
      accountableHumanId: 'human:founder',
      ownerName: 'Founder',
      rootDir,
    });
    expect(result.status).toBe('ready');
    const profile = JSON.parse(
      safeReadFile(`${rootDir}/customer/acme-ai/organization-profile.json`, {
        encoding: 'utf8',
      }) as string
    );
    expect(profile.accountable_human_resource_id).toBe('human:founder');
    expect(profile.workforce.default_budget_posture).toBe('block');
    const readiness = JSON.parse(
      safeReadFile(result.readinessPath, { encoding: 'utf8' }) as string
    );
    expect(readiness.accountable_human.final_decision_holder).toBe(true);
    expect(readiness.workforce[0].accountable_human_id).toBe('human:founder');
    expect(safeReadFile(result.firstWorkPath, { encoding: 'utf8' })).toContain(
      'Define the first customer outcome'
    );
  });

  it('restores company files when tenant binding is rejected', () => {
    safeMkdir(`${rootDir}/customer/acme-ai`, { recursive: true });
    writeTenantProfile(
      {
        tenant_slug: 'acme-prod',
        tenant_id: 'acme-prod',
        display_name: 'Another Company',
        status: 'active',
        assigned_role: 'owner',
      },
      { rootDir, env: { KYBERION_CUSTOMER: 'acme-ai' } }
    );

    expect(() =>
      onboardAiCompany({
        vertical: 'saas-product-company',
        slug: 'acme-ai',
        companyName: 'ACME AI',
        firstWork: 'Define the first customer outcome and launch plan',
        tenantSlug: 'acme-prod',
        rootDir,
      })
    ).toThrow("Tenant 'acme-prod' already belongs to 'Another Company'");
    expect(safeExistsSync(`${rootDir}/customer/acme-ai/organization-profile.json`)).toBe(false);
    expect(safeExistsSync(`${rootDir}/customer/acme-ai/onboarding/ai-company-readiness.json`)).toBe(
      false
    );
    expect(safeExistsSync(`${rootDir}/customer/acme-ai/onboarding/first-work-plan.md`)).toBe(false);
  });
});
