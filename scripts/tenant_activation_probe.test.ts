import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyOnboardingContextBinding } from '@agent/core/organization/onboarding-context';
import { resolveTenantActivation } from '@agent/core/organization/tenant-activation';
import {
  createTenantActivationProbeDeps,
  runTenantActivationProbes as runScopedTenantActivationProbes,
} from '@agent/core/organization/tenant-activation-probe';
import { writeTenantProfile } from '@agent/core/organization/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  runTenantActivationProbes,
  type TenantActivationProbeDeps,
} from './tenant_activation_probe.js';

const rootDir = pathResolver.sharedTmp('tenant-activation-probe-test');
const scope = { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-acme-ai' };
const nhiId = 'kyberion://agent/org-acme-ai/planner';

function seed(strict = true, tenantSlug = scope.tenantSlug): void {
  safeMkdir(path.join(rootDir, 'customer', 'acme-ai'), { recursive: true });
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
      tenant_slug: tenantSlug,
      tenant_id: tenantSlug,
      display_name: 'ACME Production',
      status: 'active',
      assigned_role: 'owner',
      ...(strict
        ? { isolation_policy: { strict_isolation: true, allow_cross_distillation: false } }
        : {}),
    },
    { rootDir }
  );
  applyOnboardingContextBinding({ ...scope, tenantSlug, ownerId: 'human:founder', rootDir });
}

function deps(overrides: Partial<TenantActivationProbeDeps> = {}): TenantActivationProbeDeps {
  return {
    registryCheck: () => ({ exitCode: 0, output: '[check:tenant-registry] OK' }),
    servicePreflight: async () => ({ ready: true, reason: 'ok' }),
    nhiLifecycle: (id) => (id === nhiId ? 'provisioned' : null),
    viewerScopeMode: () => 'enforce',
    now: () => '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('tenant activation probe', () => {
  it('checks canonical activation prerequisites without claiming a global registry audit', async () => {
    seed();
    const input = { ...scope, nhiIds: [nhiId], serviceIds: [], rootDir };
    const scoped = createTenantActivationProbeDeps(input);
    expect(scoped.registryCheck()).toEqual({
      exitCode: 0,
      scope: 'tenant',
      output: 'tenant-scoped consistency OK',
    });
    const result = await runScopedTenantActivationProbes(input, {
      ...deps(),
      registryCheck: scoped.registryCheck,
    });
    expect(result.passed).toBe(true);
    expect(result.results.isolation_probe.detail).toContain('tenant-scoped consistency OK');
    expect(result.results.isolation_probe.detail).toContain('global registry audit not performed');
    expect(result.results.isolation_probe.detail).not.toContain('check:tenant-registry OK');
  });

  it.each([
    { tenantSlug: 'acme-private' },
    { organizationId: 'org-other' },
    { customerSlug: 'other-customer' },
    { tier: 'public' as const },
  ])('fails closed for a different activation scope: %j', (different) => {
    seed();
    const check = createTenantActivationProbeDeps({
      ...scope,
      ...different,
      nhiIds: [nhiId],
      serviceIds: [],
      rootDir,
    }).registryCheck();
    expect(check.exitCode).toBe(1);
    expect(check.scope).toBe('tenant');
    expect(check.output).toContain('ask an operator');
    expect(check.output).not.toContain('acme-private');
  });

  it.each(['missing', 'malformed', 'mismatched'])(
    'fails closed for a %s organization profile',
    (state) => {
      seed();
      const profilePath = path.join(
        rootDir,
        'customer',
        scope.customerSlug,
        'organization-profile.json'
      );
      if (state === 'missing') safeRmSync(profilePath);
      else if (state === 'malformed') safeWriteFile(profilePath, '{broken');
      else
        safeWriteFile(
          profilePath,
          String(safeReadFile(profilePath, { encoding: 'utf8' })).replace(
            'org-acme-ai',
            'org-other'
          )
        );
      expect(
        createTenantActivationProbeDeps({
          ...scope,
          nhiIds: [nhiId],
          serviceIds: [],
          rootDir,
        }).registryCheck().exitCode
      ).toBe(1);
    }
  );

  it('fails closed when the canonical tenant profile or binding is absent', () => {
    seed();
    const input = { ...scope, nhiIds: [nhiId], serviceIds: [], rootDir };
    safeRmSync(path.join(rootDir, 'knowledge', 'personal', 'tenants', scope.tenantSlug + '.json'));
    expect(createTenantActivationProbeDeps(input).registryCheck().exitCode).toBe(1);
    safeRmSync(
      path.join(rootDir, 'customer', scope.customerSlug, 'onboarding', 'organization-context.json')
    );
    expect(createTenantActivationProbeDeps(input).registryCheck().exitCode).toBe(1);
  });

  it('fails closed when canonical strict isolation is not declared', () => {
    seed(false);
    expect(
      createTenantActivationProbeDeps({
        ...scope,
        nhiIds: [nhiId],
        serviceIds: [],
        rootDir,
      }).registryCheck().exitCode
    ).toBe(1);
  });

  it('writes passing evidence that activation accepts as its probe refs', async () => {
    seed();
    const result = await runTenantActivationProbes(
      { ...scope, nhiIds: [nhiId], serviceIds: ['slack'], rootDir },
      deps()
    );

    expect(result.passed).toBe(true);
    expect(result.activate_command).toContain(`--probe-ref isolation_probe=${result.evidence_ref}`);
    const evidence = JSON.parse(
      String(safeReadFile(path.join(rootDir, result.evidence_ref), { encoding: 'utf8' }))
    );
    expect(evidence.results.service_readiness.services.slack.passed).toBe(true);

    const record = resolveTenantActivation({
      ...scope,
      ownerId: 'human:founder',
      rootDir,
      nhiIds: [nhiId],
      checks: {
        viewer_scope: true,
        nhi_provisioned: true,
        service_readiness: true,
        isolation_probe: true,
      },
      probeRefs: {
        viewer_scope: result.evidence_ref,
        nhi_provisioned: result.evidence_ref,
        service_readiness: result.evidence_ref,
        isolation_probe: result.evidence_ref,
      },
    }).record;
    expect(record.blockers).toEqual([]);
    expect(record.status).toBe('ready');
  });

  it("keeps other tenants out of this tenant's registry-failure evidence", async () => {
    seed(true);
    const result = await runTenantActivationProbes(
      { ...scope, nhiIds: [], serviceIds: [], rootDir },
      deps({
        registryCheck: () => ({
          exitCode: 1,
          output: `- other-tenant-xyz: missing profile\n- ${scope.tenantSlug}: isolation drift`,
        }),
      })
    );
    const detail = result.results.isolation_probe.detail;
    expect(detail).toContain('check:tenant-registry failed');
    expect(detail).not.toContain('isolation drift');
    expect(detail).not.toContain('other-tenant-xyz');
  });

  it('never persists global diagnostics for a tenant with an overlapping slug', async () => {
    seed(true, 'acme');
    const result = await runTenantActivationProbes(
      { ...scope, tenantSlug: 'acme', nhiIds: [nhiId], serviceIds: [], rootDir },
      deps({
        registryCheck: () => ({
          exitCode: 1,
          output: [
            '- acme-private: confidential diagnostics',
            '- acme: conflicts with acme-private in the global registry',
          ].join('\n'),
        }),
      })
    );
    const persisted = String(
      safeReadFile(path.join(rootDir, result.evidence_ref), { encoding: 'utf8' })
    );
    expect(result.passed).toBe(false);
    expect(result.results.isolation_probe.passed).toBe(false);
    expect(result.results.isolation_probe.detail).toContain('check:tenant-registry failed');
    expect(result.results.isolation_probe.detail).not.toContain('acme-private');
    expect(persisted).not.toContain('acme-private');
    expect(persisted).not.toContain('confidential diagnostics');
  });

  it('fails each probe with the reason an operator can act on', async () => {
    seed(false);
    const result = await runTenantActivationProbes(
      { ...scope, nhiIds: ['kyberion://agent/org-acme-ai/ghost'], serviceIds: ['slack'], rootDir },
      deps({
        servicePreflight: async () => ({ ready: false, reason: 'auth missing' }),
        viewerScopeMode: () => 'off',
      })
    );

    expect(result.passed).toBe(false);
    expect(result.activate_command).toBeNull();
    expect(result.results.isolation_probe.detail).toContain('isolation_policy is not strict');
    expect(result.results.viewer_scope.detail).toContain('KYBERION_VIEWER_SCOPE=off');
    expect(result.results.nhi_provisioned.detail).toContain('is not in the NHI ledger');
    expect(result.results.service_readiness.detail).toContain('slack (auth missing)');
  });
});
