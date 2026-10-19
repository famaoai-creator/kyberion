/**
 * `pnpm tenant:activation probe` — runs the four activation probes against the
 * real state, writes one evidence file beside the activation receipt, and
 * prints the refs `activate` needs. It never activates anything and never
 * issues an NHI: it only observes, so a failed probe names what to fix.
 */
import * as path from 'node:path';
import { getAgentIdentity } from '../agent/agent-identity.js';
import { getRegisteredEnvText, nowIso } from '../foundation/index.js';
import { loadOnboardingContextBinding } from './onboarding-context.js';
import {
  TENANT_ACTIVATION_PROBE_CHECKS,
  TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
  tenantActivationProbeEvidenceDir,
  resolveTenantActivation,
  type TenantActivationProbeCheck,
} from './tenant-activation.js';
import { resolveTenant } from './tenant-registry.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from '../secure-io.js';
import { loadOrganizationProfileAtPath } from './organization-profile.js';
import { runServicePreflight } from '../service/service-preflight.js';

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
  registryCheck: () => { exitCode: number; output: string; scope?: 'tenant' | 'global' };
  servicePreflight: (serviceId: string) => Promise<{ ready: boolean; reason: string }>;
  nhiLifecycle: (nhiId: string) => string | null;
  viewerScopeMode: () => string;
  now: () => string;
}

/** The canonical prerequisites that must pass before any activation evidence can be used. */
const SCOPED_ACTIVATION_CHECKS = [
  'registry',
  'context_binding',
  'organization_state',
  'accountable_human',
  'memory_policy',
] as const;

/**
 * Read only the requested activation scope. This is not the operator's global
 * registry audit: no tenant listing, global index or role assumption belongs here.
 */
function checkTenantScopedConsistency(
  input: TenantActivationProbeInput
): ReturnType<TenantActivationProbeDeps['registryCheck']> {
  const failure = {
    exitCode: 1,
    scope: 'tenant' as const,
    output:
      'tenant-scoped consistency failed; ask an operator to repair or authorize the missing, malformed, mismatched or unreadable activation records',
  };
  try {
    const rootDir = input.rootDir || pathResolver.rootDir();
    const binding = loadOnboardingContextBinding(input.customerSlug, rootDir);
    if (
      !binding ||
      binding.customer_slug !== input.customerSlug ||
      binding.tenant_slug !== input.tenantSlug ||
      binding.organization_id !== input.organizationId ||
      binding.tier !== (input.tier || 'confidential')
    )
      return failure;
    const profile = loadOrganizationProfileAtPath(
      assertSafeRepositoryPath(
        path.join(rootDir, 'customer', input.customerSlug, 'organization-profile.json'),
        { rootDir }
      )
    );
    if (profile.organization_id !== input.organizationId) return failure;
    const { checks } = resolveTenantActivation(input).record;
    if (!SCOPED_ACTIVATION_CHECKS.every((check) => checks[check])) return failure;
    return { exitCode: 0, scope: 'tenant', output: 'tenant-scoped consistency OK' };
  } catch {
    // Do not retry under another role or copy filesystem/registry details into
    // tenant evidence. An operator must repair records or their existing access.
    return failure;
  }
}

/** Scoped production dependencies; CLI callers explicitly compose the global audit. */
export function createTenantActivationProbeDeps(
  input: TenantActivationProbeInput
): TenantActivationProbeDeps {
  return {
    registryCheck: () => checkTenantScopedConsistency(input),
    servicePreflight: async (serviceId) => {
      const { reports, ready } = await runServicePreflight({ serviceId });
      return { ready, reason: reports.map((report) => report.reason).join(' | ') };
    },
    nhiLifecycle: (nhiId) => getAgentIdentity(nhiId)?.lifecycle_status ?? null,
    viewerScopeMode: () => getRegisteredEnvText('KYBERION_VIEWER_SCOPE') || 'warn',
    now: nowIso,
  };
}

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
    // The registry report is system-scoped and its free-text diagnostics can
    // name several tenants on the same line. Never copy any of that output
    // into tenant-scoped evidence, even when the line matches this slug.
    problems.push(
      check.scope === 'tenant'
        ? check.output
        : 'check:tenant-registry failed (run `pnpm check -- --only tenant-registry` for the full report)'
    );
  }
  return problems.length
    ? { passed: false, detail: problems.join('\n') }
    : {
        passed: true,
        detail:
          check.scope === 'tenant'
            ? 'strict isolation declared; tenant-scoped consistency OK (global registry audit not performed)'
            : 'strict isolation declared; check:tenant-registry OK',
      };
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
  deps: TenantActivationProbeDeps = createTenantActivationProbeDeps(input)
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
