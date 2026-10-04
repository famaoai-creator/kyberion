import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  applyTenantActivation,
  isTenantActivationActive,
  loadTenantActivation,
  rollbackTenantActivation,
  resolveTenantActivation,
  suspendTenantActivation,
  TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
  tenantActivationProbeEvidenceDir,
} from './tenant-activation.js';
import { applyOnboardingContextBinding } from './onboarding-context.js';
import { writeTenantProfile } from './tenant-registry.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';

const rootDir = path.join(process.cwd(), 'active/shared/tmp/tenant-activation-test');
const probeRefs = {
  viewer_scope: 'probe://viewer-scope/acme-prod/1',
  nhi_provisioned: 'probe://nhi/acme-prod/1',
  service_readiness: 'probe://services/acme-prod/1',
  isolation_probe: 'probe://isolation/acme-prod/1',
};

function seed(): void {
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
      tenant_slug: 'acme-prod',
      tenant_id: 'acme-prod',
      display_name: 'ACME Production',
      status: 'active',
      assigned_role: 'owner',
      isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
    },
    { rootDir }
  );
  applyOnboardingContextBinding({
    customerSlug: 'acme-ai',
    tenantSlug: 'acme-prod',
    organizationId: 'org-acme-ai',
    ownerId: 'human:founder',
    rootDir,
  });
}

afterEach(() => safeRmSync(rootDir, { recursive: true, force: true }));

describe('tenant activation', () => {
  it('reports explicit blockers instead of claiming onboarding is active', () => {
    seed();
    const result = resolveTenantActivation({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    });
    expect(result.record.status).toBe('validating');
    expect(result.record.owner_id).toBe('human:founder');
    expect(result.record.checks.accountable_human).toBe(true);
    expect(result.record.blockers).toEqual(
      expect.arrayContaining([
        'viewer_scope requires an explicit successful probe',
        'nhi_provisioned requires an explicit successful probe',
      ])
    );
  });

  it('requires a nonempty human resource suffix and keeps unowned dry-runs schema-valid', () => {
    seed();
    const scope = {
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      rootDir,
    };
    const invalidOwner = resolveTenantActivation({ ...scope, ownerId: 'human:' });
    expect(invalidOwner.record.checks.accountable_human).toBe(false);
    expect(invalidOwner.record.blockers).toContain(
      'accountable_human must be an explicit human:* resource'
    );
    const whitespaceOwner = resolveTenantActivation({ ...scope, ownerId: 'human: founder' });
    expect(whitespaceOwner.record.checks.accountable_human).toBe(false);
    expect(whitespaceOwner.record.blockers).toContain(
      'accountable_human must be an explicit human:* resource'
    );

    safeRmSync(path.join(rootDir, 'customer/acme-ai/onboarding/organization-context.json'), {
      force: true,
    });
    const unowned = resolveTenantActivation(scope);
    expect(unowned.record.owner_id).toBe('');
    expect(unowned.record.checks.accountable_human).toBe(false);
    safeMkdir(path.dirname(unowned.activation_path), { recursive: true });
    safeWriteFile(unowned.activation_path, JSON.stringify(unowned.record));
    expect(loadTenantActivation(scope, rootDir)?.owner_id).toBe('');
  });

  it('fails closed when the organization context binding is schema-invalid or a directory', () => {
    seed();
    const bindingPath = path.join(
      rootDir,
      'customer',
      'acme-ai',
      'onboarding',
      'organization-context.json'
    );
    safeWriteFile(
      bindingPath,
      JSON.stringify({
        version: '1.0.0',
        kind: 'onboarding_context_binding',
        customer_slug: 'acme-ai',
        tenant_slug: 'acme-prod',
        organization_id: 'org-acme-ai',
        tier: 'confidential',
        owner_id: 'human:founder',
        status: 'active',
        default_service_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        unexpected: true,
      })
    );
    expect(
      resolveTenantActivation({
        customerSlug: 'acme-ai',
        tenantSlug: 'acme-prod',
        organizationId: 'org-acme-ai',
        rootDir,
      }).record.checks.context_binding
    ).toBe(false);

    safeRmSync(bindingPath, { recursive: true, force: true });
    safeMkdir(bindingPath, { recursive: true });
    expect(
      resolveTenantActivation({
        customerSlug: 'acme-ai',
        tenantSlug: 'acme-prod',
        organizationId: 'org-acme-ai',
        rootDir,
      }).record.checks.context_binding
    ).toBe(false);
  });

  it('activates only after all explicit probes and human acceptance pass', () => {
    seed();
    const record = applyTenantActivation({
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
      probeRefs,
    });
    expect(record.status).toBe('active');
    expect(
      isTenantActivationActive(
        { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-acme-ai' },
        rootDir
      )
    ).toBe(true);
    expect(
      resolveTenantActivation({
        customerSlug: 'acme-ai',
        tenantSlug: 'acme-prod',
        organizationId: 'org-acme-ai',
        rootDir,
        checks: {
          viewer_scope: true,
          nhi_provisioned: true,
          service_readiness: true,
          isolation_probe: true,
        },
        nhiIds: ['kyberion://agent/org-acme-ai/planner'],
        probeRefs,
      }).would_write
    ).toEqual([]);
  });

  it('rejects probe flags without evidence refs or a provisioned NHI id', () => {
    seed();
    expect(() =>
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
      })
    ).toThrow(/auditable probe reference|provisioned NHI id/);
  });

  it('rejects missing evidence paths, failed probe evidence, and foreign NHI ids', () => {
    seed();
    const evidenceDir = tenantActivationProbeEvidenceDir(
      { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-acme-ai' },
      rootDir
    );
    const evidencePath = path.join(evidenceDir, 'probe.json');
    safeWriteFile(
      evidencePath,
      JSON.stringify({
        kind: TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
        customer_slug: 'acme-ai',
        tenant_slug: 'acme-prod',
        organization_id: 'org-acme-ai',
        results: {
          isolation_probe: { passed: true },
          service_readiness: { passed: false },
        },
      }),
      { mkdir: true }
    );
    const evidenceRef = path.relative(rootDir, evidencePath);
    const blockers = resolveTenantActivation({
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      ownerId: 'human:founder',
      rootDir,
      checks: {
        viewer_scope: true,
        nhi_provisioned: true,
        service_readiness: true,
        isolation_probe: true,
      },
      nhiIds: ['kyberion://agent/other-org/planner'],
      probeRefs: {
        viewer_scope: 'active/shared/tmp/does-not-exist.txt',
        nhi_provisioned: probeRefs.nhi_provisioned,
        service_readiness: evidenceRef,
        isolation_probe: evidenceRef,
      },
    }).record.blockers;

    expect(blockers).toContain(
      "viewer_scope probe ref 'active/shared/tmp/does-not-exist.txt' does not exist"
    );
    expect(blockers).toContain(`service_readiness probe evidence '${evidenceRef}' did not pass`);
    expect(blockers.some((blocker) => blocker.startsWith('isolation_probe'))).toBe(false);
    expect(
      blockers.some((blocker) => blocker.includes("'kyberion://agent/other-org/planner'"))
    ).toBe(true);
  });

  it('does not let a receipt for one organization satisfy another context', () => {
    seed();
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
      probeRefs,
    });
    expect(
      isTenantActivationActive(
        { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-other' },
        rootDir
      )
    ).toBe(false);
  });

  it('does not treat a schema-invalid activation receipt as active', () => {
    seed();
    const receiptPath = path.join(
      rootDir,
      'customer',
      'acme-ai',
      'onboarding',
      'tenant-activation',
      'acme-prod',
      'org-acme-ai',
      'confidential',
      'activation.json'
    );
    safeMkdir(path.dirname(receiptPath), { recursive: true });
    safeWriteFile(receiptPath, JSON.stringify({ kind: 'tenant_activation' }));

    expect(
      isTenantActivationActive(
        { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-acme-ai' },
        rootDir
      )
    ).toBe(false);
  });

  it('supports recoverable suspend, rollback, and resume transitions', () => {
    seed();
    const input = {
      customerSlug: 'acme-ai',
      tenantSlug: 'acme-prod',
      organizationId: 'org-acme-ai',
      ownerId: 'human:founder',
      rootDir,
      checks: {
        viewer_scope: true,
        nhi_provisioned: true,
        service_readiness: true,
        isolation_probe: true,
      },
      nhiIds: ['kyberion://agent/org-acme-ai/planner'],
      probeRefs,
    } as const;
    applyTenantActivation({ ...input, accept: true });
    expect(
      suspendTenantActivation({
        customerSlug: 'acme-ai',
        tenantSlug: 'acme-prod',
        organizationId: 'org-acme-ai',
        reason: 'probe drift',
        rootDir,
        accept: true,
      }).status
    ).toBe('suspended');
    expect(
      isTenantActivationActive(
        { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-acme-ai' },
        rootDir
      )
    ).toBe(false);
    expect(
      rollbackTenantActivation({
        customerSlug: 'acme-ai',
        tenantSlug: 'acme-prod',
        organizationId: 'org-acme-ai',
        reason: 'rebuild binding',
        rootDir,
        accept: true,
      }).status
    ).toBe('draft');
    expect(
      isTenantActivationActive(
        { customerSlug: 'acme-ai', tenantSlug: 'acme-prod', organizationId: 'org-acme-ai' },
        rootDir
      )
    ).toBe(false);
    expect(applyTenantActivation({ ...input, accept: true }).status).toBe('active');
  });
});
