/**
 * `pnpm tenant:activation probe` — runs the four activation probes against the
 * real state, writes one evidence file beside the activation receipt, and
 * prints the refs `activate` needs. It never activates anything and never
 * issues an NHI: it only observes, so a failed probe names what to fix.
 */
import * as path from 'node:path';
import { getAgentIdentity } from '@agent/core/agent/agent-identity';
import { getRegisteredEnvText, nowIso } from '@agent/core/foundation';
import { loadOnboardingContextBinding } from '@agent/core/organization/onboarding-context';
import {
  TENANT_ACTIVATION_PROBE_CHECKS,
  TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
  tenantActivationProbeEvidenceDir,
  type TenantActivationProbeCheck,
} from '@agent/core/organization/tenant-activation';
import { resolveTenant } from '@agent/core/organization/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { runCheck as runTenantRegistryCheck } from './check_tenant_registry_consistency.js';
import { runServicePreflight } from './service_preflight.js';

export interface ProbeResult {
  passed: boolean;
  detail: string;
}

export interface TenantActivationProbeInput {
  customerSlug: string;
  tenantSlug: string;
  organizationId: string;
  tier?: 'personal' | 'confidential' | 'public';
  nhiIds: string[];
  serviceIds: string[];
  rootDir?: string;
}

export interface TenantActivationProbeDeps {
  registryCheck: () => { exitCode: number; output: string };
  servicePreflight: (serviceId: string) => Promise<{ ready: boolean; reason: string }>;
  nhiLifecycle: (nhiId: string) => string | null;
  viewerScopeMode: () => string;
  now: () => string;
}

const defaultDeps: TenantActivationProbeDeps = {
  registryCheck: () => runTenantRegistryCheck(),
  servicePreflight: async (serviceId) => {
    const { reports, ready } = await runServicePreflight({ serviceId });
    return { ready, reason: reports.map((report) => report.reason).join(' | ') };
  },
  nhiLifecycle: (nhiId) => getAgentIdentity(nhiId)?.lifecycle_status ?? null,
  viewerScopeMode: () => getRegisteredEnvText('KYBERION_VIEWER_SCOPE') || 'warn',
  now: nowIso,
};

function isolationProbe(input: TenantActivationProbeInput, deps: TenantActivationProbeDeps) {
  const problems: string[] = [];
  try {
    const policy = resolveTenant(input.tenantSlug, { rootDir: input.rootDir }).profile
      .isolation_policy;
    if (policy?.strict_isolation !== true || policy.allow_cross_distillation === true) {
      problems.push(
        'tenant isolation_policy is not strict (strict_isolation / no cross-distillation)'
      );
    }
  } catch (error) {
    problems.push(`tenant registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  const check = deps.registryCheck();
  if (check.exitCode !== 0) {
    // The registry check reports every tenant; keep only this tenant's lines in
    // this tenant's evidence so other tenants' slugs never land in it.
    const own = check.output
      .split('\n')
      .filter((line) => line.includes(input.tenantSlug))
      .join('\n');
    problems.push(
      `check:tenant-registry failed${own ? `:\n${own}` : ''} (run \`pnpm check -- --only tenant-registry\` for the full report)`
    );
  }
  return problems.length
    ? { passed: false, detail: problems.join('\n') }
    : { passed: true, detail: 'strict isolation declared; check:tenant-registry OK' };
}

function viewerScopeProbe(
  input: TenantActivationProbeInput,
  deps: TenantActivationProbeDeps
): ProbeResult {
  const mode = deps.viewerScopeMode();
  if (mode === 'off') {
    return {
      passed: false,
      detail: 'KYBERION_VIEWER_SCOPE=off: viewer tenant scope is not audited or enforced',
    };
  }
  try {
    const status = resolveTenant(input.tenantSlug, { rootDir: input.rootDir }).profile.status;
    if (status !== 'active') return { passed: false, detail: `tenant is ${status}, not active` };
  } catch (error) {
    return { passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
  return {
    passed: true,
    detail: `tenant is registered and active, so viewer narrowing resolves it; KYBERION_VIEWER_SCOPE=${mode} (${mode === 'enforce' ? 'out-of-scope reads are denied' : 'out-of-scope reads are audited; set enforce to deny'})`,
  };
}

function nhiProbe(input: TenantActivationProbeInput, deps: TenantActivationProbeDeps): ProbeResult {
  if (input.nhiIds.length === 0) {
    return {
      passed: false,
      detail: `pass --nhi-id kyberion://agent/${input.organizationId}/<agent-slug> for each AI worker`,
    };
  }
  const problems = input.nhiIds.flatMap((nhiId) => {
    const lifecycle = deps.nhiLifecycle(nhiId);
    if (!lifecycle) return [`${nhiId} is not in the NHI ledger`];
    if (lifecycle === 'retired' || lifecycle === 'suspended') return [`${nhiId} is ${lifecycle}`];
    return [];
  });
  return problems.length
    ? { passed: false, detail: problems.join('\n') }
    : { passed: true, detail: `${input.nhiIds.join(', ')} present in the NHI ledger` };
}

async function serviceProbe(
  serviceIds: string[],
  deps: TenantActivationProbeDeps
): Promise<ProbeResult & { services: Record<string, ProbeResult> }> {
  const services: Record<string, ProbeResult> = {};
  for (const serviceId of serviceIds) {
    try {
      const { ready, reason } = await deps.servicePreflight(serviceId);
      services[serviceId] = { passed: ready, detail: reason };
    } catch (error) {
      services[serviceId] = {
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (serviceIds.length === 0) {
    return {
      passed: true,
      detail:
        'no external services declared for first work (binding default_service_ids and --service are empty)',
      services,
    };
  }
  const failed = Object.entries(services).filter(([, result]) => !result.passed);
  return {
    passed: failed.length === 0,
    detail: failed.length
      ? `not ready: ${failed.map(([id, result]) => `${id} (${result.detail})`).join('; ')}`
      : `ready: ${serviceIds.join(', ')}`,
    services,
  };
}

export async function runTenantActivationProbes(
  input: TenantActivationProbeInput,
  deps: TenantActivationProbeDeps = defaultDeps
) {
  const rootDir = input.rootDir || pathResolver.rootDir();
  const binding = loadOnboardingContextBinding(input.customerSlug, rootDir);
  const serviceIds = [...new Set([...(binding?.default_service_ids ?? []), ...input.serviceIds])];
  const results: Record<TenantActivationProbeCheck, ProbeResult> = {
    isolation_probe: isolationProbe(input, deps),
    viewer_scope: viewerScopeProbe(input, deps),
    nhi_provisioned: nhiProbe(input, deps),
    service_readiness: await serviceProbe(serviceIds, deps),
  };
  const createdAt = deps.now();
  const evidence = {
    version: '1.0.0',
    kind: TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
    customer_slug: input.customerSlug,
    tenant_slug: input.tenantSlug,
    organization_id: input.organizationId,
    tier: input.tier || 'confidential',
    nhi_ids: input.nhiIds,
    created_at: createdAt,
    results,
  };
  const dir = tenantActivationProbeEvidenceDir(input, rootDir);
  const filePath = assertSafeRepositoryPath(
    path.join(dir, `probe-${createdAt.replace(/[:.]/g, '-')}.json`),
    { allowMissingLeaf: true, rootDir }
  );
  safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(evidence, null, 2) + '\n');
  const evidenceRef = path.relative(rootDir, filePath);
  const passed = TENANT_ACTIVATION_PROBE_CHECKS.every((check) => results[check].passed);
  const flags: Record<TenantActivationProbeCheck, string> = {
    viewer_scope: '--check-viewer-scope',
    nhi_provisioned: '--check-nhi',
    service_readiness: '--check-services',
    isolation_probe: '--check-isolation',
  };
  const activateCommand = passed
    ? [
        'pnpm tenant:activation activate',
        `--customer-slug ${input.customerSlug} --tenant-slug ${input.tenantSlug} --organization-id ${input.organizationId}`,
        ...input.nhiIds.map((nhiId) => `--nhi-id ${nhiId}`),
        ...TENANT_ACTIVATION_PROBE_CHECKS.map(
          (check) => `${flags[check]} --probe-ref ${check}=${evidenceRef}`
        ),
        '--owner-id <human:owner> --apply --accept',
      ].join(' ')
    : null;
  return { passed, evidence_ref: evidenceRef, results, activate_command: activateCommand };
}
