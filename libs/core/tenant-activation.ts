import * as path from 'node:path';
import { resolveTenant } from './tenant-registry.js';
import { loadOrganizationOperationalState } from './organization-operating-model.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { revokeGrantsForTenantBestEffort } from './task-scoped-grants.js';

export const TENANT_ACTIVATION_CHECKS = [
  'registry',
  'context_binding',
  'organization_state',
  'accountable_human',
  'memory_policy',
  'viewer_scope',
  'nhi_provisioned',
  'service_readiness',
  'isolation_probe',
] as const;

export const TENANT_ACTIVATION_PROBE_CHECKS = [
  'viewer_scope',
  'nhi_provisioned',
  'service_readiness',
  'isolation_probe',
] as const;

export type TenantActivationCheck = (typeof TENANT_ACTIVATION_CHECKS)[number];
export type TenantActivationProbeCheck = (typeof TENANT_ACTIVATION_PROBE_CHECKS)[number];
export type TenantActivationProbeRefs = Partial<Record<TenantActivationProbeCheck, string>>;
export type TenantActivationStatus =
  'draft' | 'validating' | 'ready' | 'active' | 'suspended' | 'offboarding' | 'archived';

export interface TenantActivationRecord {
  version: '1.0.0';
  kind: 'tenant_activation';
  customer_slug: string;
  tenant_slug: string;
  organization_id: string;
  tier: 'personal' | 'confidential' | 'public';
  owner_id: string;
  customer_stance: string;
  nhi_ids: string[];
  next_actions: string[];
  operation_contract: {
    task_leases: boolean;
    heartbeat_watchdog: boolean;
    quota_and_budget: boolean;
    approval_gate: boolean;
    pause_and_escalation: boolean;
    drift_watcher: boolean;
  };
  revoked_task_grants?: number;
  status: TenantActivationStatus;
  checks: Record<TenantActivationCheck, boolean>;
  probe_refs: TenantActivationProbeRefs;
  blockers: string[];
  created_at: string;
  updated_at: string;
  activated_at?: string;
}

export interface TenantActivationScope {
  customerSlug: string;
  tenantSlug: string;
  organizationId: string;
  tier?: TenantActivationRecord['tier'];
}

export interface TenantActivationInput extends TenantActivationScope {
  ownerId?: string;
  nhiIds?: string[];
  nextActions?: string[];
  checks?: Partial<Record<TenantActivationCheck, boolean>>;
  probeRefs?: TenantActivationProbeRefs;
  rootDir?: string;
}

export interface TenantActivationResolution {
  mode: 'dry_run';
  record: TenantActivationRecord;
  activation_path: string;
  would_write: string[];
}

function pathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function activationPath(input: TenantActivationScope, rootDir: string): string {
  return path.join(
    rootDir,
    'customer',
    input.customerSlug,
    'onboarding',
    'tenant-activation',
    pathSegment(input.tenantSlug),
    pathSegment(input.organizationId),
    input.tier || 'confidential',
    'activation.json'
  );
}

function activationPathForRecord(record: TenantActivationRecord, rootDir: string): string {
  return activationPath(
    {
      customerSlug: record.customer_slug,
      tenantSlug: record.tenant_slug,
      organizationId: record.organization_id,
      tier: record.tier,
    },
    rootDir
  );
}

function legacyActivationPath(customerSlug: string, rootDir: string): string {
  return path.join(rootDir, 'customer', customerSlug, 'onboarding', 'tenant-activation.json');
}

function bindingPath(customerSlug: string, rootDir: string): string {
  return path.join(rootDir, 'customer', customerSlug, 'onboarding', 'organization-context.json');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readBinding(customerSlug: string, rootDir: string): Record<string, unknown> | null {
  const filePath = bindingPath(customerSlug, rootDir);
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' })));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function emptyChecks(): Record<TenantActivationCheck, boolean> {
  return Object.fromEntries(TENANT_ACTIVATION_CHECKS.map((check) => [check, false])) as Record<
    TenantActivationCheck,
    boolean
  >;
}

function normalizeProbeRefs(input: TenantActivationInput): TenantActivationProbeRefs {
  return Object.fromEntries(
    TENANT_ACTIVATION_PROBE_CHECKS.flatMap((check) => {
      const ref = input.probeRefs?.[check]?.trim();
      return ref ? [[check, ref]] : [];
    })
  ) as TenantActivationProbeRefs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTenantActivationRecord(value: unknown): value is TenantActivationRecord {
  if (!isRecord(value)) return false;
  if (
    value.version !== '1.0.0' ||
    value.kind !== 'tenant_activation' ||
    !nonEmpty(value.customer_slug) ||
    !nonEmpty(value.tenant_slug) ||
    !nonEmpty(value.organization_id) ||
    !['personal', 'confidential', 'public'].includes(String(value.tier)) ||
    !nonEmpty(value.owner_id) ||
    !nonEmpty(value.customer_stance) ||
    !Array.isArray(value.nhi_ids) ||
    value.nhi_ids.some((id) => !nonEmpty(id)) ||
    !Array.isArray(value.next_actions) ||
    value.next_actions.some((action) => !nonEmpty(action)) ||
    !isRecord(value.operation_contract) ||
    !isRecord(value.checks) ||
    !isRecord(value.probe_refs) ||
    !Array.isArray(value.blockers) ||
    value.blockers.some((blocker) => typeof blocker !== 'string') ||
    !nonEmpty(value.created_at) ||
    !nonEmpty(value.updated_at) ||
    (value.activated_at !== undefined && !nonEmpty(value.activated_at)) ||
    !['draft', 'validating', 'ready', 'active', 'suspended', 'offboarding', 'archived'].includes(
      String(value.status)
    )
  ) {
    return false;
  }
  if (
    TENANT_ACTIVATION_CHECKS.some((check) => typeof value.checks?.[check] !== 'boolean') ||
    Object.values(value.probe_refs).some((ref) => !nonEmpty(ref))
  ) {
    return false;
  }
  return [
    'task_leases',
    'heartbeat_watchdog',
    'quota_and_budget',
    'approval_gate',
    'pause_and_escalation',
    'drift_watcher',
  ].every((key) => typeof value.operation_contract?.[key] === 'boolean');
}

function buildChecks(
  input: TenantActivationInput,
  nhiIds: string[]
): {
  checks: Record<TenantActivationCheck, boolean>;
  probeRefs: TenantActivationProbeRefs;
  blockers: string[];
} {
  const checks = emptyChecks();
  const blockers: string[] = [];
  const probeRefs = normalizeProbeRefs(input);
  let tenant: ReturnType<typeof resolveTenant> | null = null;
  try {
    tenant = resolveTenant(input.tenantSlug, { rootDir: input.rootDir });
    checks.registry = tenant.profile.status === 'active';
  } catch (error) {
    blockers.push(`registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!checks.registry) blockers.push('registry is not active');

  const rootDir = input.rootDir || pathResolver.rootDir();
  const binding = readBinding(input.customerSlug, rootDir);
  checks.context_binding = Boolean(
    binding &&
    binding.customer_slug === input.customerSlug &&
    binding.tenant_slug === input.tenantSlug &&
    binding.organization_id === input.organizationId &&
    binding.tier === (input.tier || 'confidential')
  );
  if (!checks.context_binding)
    blockers.push('organization context binding is missing or mismatched');

  const state = loadOrganizationOperationalState(input.organizationId, {
    tier: input.tier || 'confidential',
    tenantSlug: input.tenantSlug,
    rootDir,
  });
  checks.organization_state = Boolean(
    state && state.status === 'active' && state.tenant_slug === input.tenantSlug
  );
  if (!checks.organization_state)
    blockers.push('organization operational state is not active and tenant-bound');

  const ownerId = input.ownerId || (nonEmpty(binding?.owner_id) ? binding?.owner_id : undefined);
  checks.accountable_human = Boolean(ownerId && ownerId.startsWith('human:'));
  if (!checks.accountable_human)
    blockers.push('accountable_human must be an explicit human:* resource');

  checks.memory_policy = Boolean(
    tenant?.profile.isolation_policy?.strict_isolation === true &&
    tenant.profile.isolation_policy?.allow_cross_distillation !== true
  );
  if (!checks.memory_policy)
    blockers.push(
      'memory policy must enforce strict isolation and deny cross-distillation by default'
    );

  for (const check of TENANT_ACTIVATION_PROBE_CHECKS) {
    const asserted = input.checks?.[check] === true;
    const ref = probeRefs[check];
    checks[check] = asserted && Boolean(ref);
    if (!asserted) blockers.push(`${check} requires an explicit successful probe`);
    else if (!ref) blockers.push(`${check} requires an auditable probe reference`);
    if (check === 'nhi_provisioned' && checks[check] && nhiIds.length === 0) {
      checks[check] = false;
      blockers.push('nhi_provisioned requires at least one provisioned NHI id');
    }
  }
  return { checks, probeRefs, blockers: [...new Set(blockers)] };
}

export function loadTenantActivation(
  input: TenantActivationScope,
  rootDir = pathResolver.rootDir()
): TenantActivationRecord | null {
  const expectedTier = input.tier || 'confidential';
  const candidates = [
    activationPath({ ...input, tier: expectedTier }, rootDir),
    legacyActivationPath(input.customerSlug, rootDir),
  ];
  for (const filePath of candidates) {
    if (!safeExistsSync(filePath)) continue;
    try {
      const value = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as unknown;
      if (
        !isTenantActivationRecord(value) ||
        value.customer_slug !== input.customerSlug ||
        value.tenant_slug !== input.tenantSlug ||
        value.organization_id !== input.organizationId ||
        value.tier !== expectedTier ||
        value.customer_stance !== input.customerSlug
      )
        continue;
      return value;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveTenantActivation(input: TenantActivationInput): TenantActivationResolution {
  const rootDir = input.rootDir || pathResolver.rootDir();
  const now = new Date().toISOString();
  const previous = loadTenantActivation(input, rootDir);
  const nhiIds = (input.nhiIds || previous?.nhi_ids || []).map((id) => id.trim()).filter(Boolean);
  const { checks, probeRefs, blockers } = buildChecks(input, nhiIds);
  const active = previous?.status === 'active' && blockers.length === 0;
  const record: TenantActivationRecord = {
    version: '1.0.0',
    kind: 'tenant_activation',
    customer_slug: input.customerSlug,
    tenant_slug: input.tenantSlug,
    organization_id: input.organizationId,
    tier: input.tier || 'confidential',
    owner_id: input.ownerId || previous?.owner_id || 'human:operator',
    customer_stance: input.customerSlug,
    nhi_ids: nhiIds,
    next_actions: input.nextActions || [
      'confirm viewer scope, NHI, service readiness, and isolation probes',
      'review the first-work plan before starting a mission',
    ],
    operation_contract: {
      task_leases: true,
      heartbeat_watchdog: true,
      quota_and_budget: true,
      approval_gate: true,
      pause_and_escalation: true,
      drift_watcher: true,
    },
    status: active ? 'active' : blockers.length === 0 ? 'ready' : 'validating',
    checks,
    probe_refs: probeRefs,
    blockers,
    created_at: previous?.created_at || now,
    updated_at: now,
    ...(active ? { activated_at: previous?.activated_at || now } : {}),
  };
  const filePath = activationPath(input, rootDir);
  const equivalent = Boolean(
    previous &&
    previous.status === record.status &&
    JSON.stringify(previous.checks) === JSON.stringify(record.checks) &&
    JSON.stringify(previous.probe_refs) === JSON.stringify(record.probe_refs) &&
    JSON.stringify(previous.blockers) === JSON.stringify(record.blockers) &&
    JSON.stringify(previous.nhi_ids) === JSON.stringify(record.nhi_ids)
  );
  return {
    mode: 'dry_run',
    record,
    activation_path: filePath,
    would_write: equivalent ? [] : [filePath],
  };
}

export function applyTenantActivation(
  input: TenantActivationInput & { accept: boolean }
): TenantActivationRecord {
  if (!input.accept) throw new Error('Human acceptance is required before tenant activation.');
  const resolved = resolveTenantActivation(input);
  if (resolved.record.blockers.length > 0) {
    throw new Error(`[TENANT_ACTIVATION_BLOCKED] ${resolved.record.blockers.join('; ')}`);
  }
  const rootDir = input.rootDir || pathResolver.rootDir();
  const filePath = resolved.activation_path;
  safeMkdir(path.dirname(filePath), { recursive: true });
  const record: TenantActivationRecord = {
    ...resolved.record,
    status: 'active',
    activated_at: resolved.record.activated_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  safeWriteFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
  return record;
}

function writeActivationRecord(
  record: TenantActivationRecord,
  rootDir: string
): TenantActivationRecord {
  const filePath = activationPathForRecord(record, rootDir);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
  return record;
}

/** Resume a suspended/draft activation after re-running all probes and accepting the result. */
export function resumeTenantActivation(
  input: TenantActivationInput & { accept: boolean }
): TenantActivationRecord {
  return applyTenantActivation(input);
}

/** Reconcile without writing; useful for watchdogs and onboarding resume screens. */
export function reconcileTenantActivation(
  input: TenantActivationInput
): TenantActivationResolution {
  return resolveTenantActivation(input);
}

/** Recoverably roll an activation back to draft; the receipt remains auditable. */
export function rollbackTenantActivation(input: {
  customerSlug: string;
  tenantSlug: string;
  organizationId: string;
  tier?: TenantActivationRecord['tier'];
  reason: string;
  rootDir?: string;
  accept: boolean;
}): TenantActivationRecord {
  if (!input.accept)
    throw new Error('Human acceptance is required before tenant activation rollback.');
  const rootDir = input.rootDir || pathResolver.rootDir();
  const current = loadTenantActivation(input, rootDir);
  if (!current)
    throw new Error(
      `No tenant activation receipt for '${input.customerSlug}/${input.tenantSlug}'.`
    );
  return writeActivationRecord(
    {
      ...current,
      status: 'draft',
      blockers: [...new Set([...current.blockers, `rollback: ${input.reason}`])],
      updated_at: new Date().toISOString(),
      activated_at: undefined,
    },
    rootDir
  );
}

/** Mark an active tenant as suspended without deleting its receipt or memory. */
export function suspendTenantActivation(input: {
  customerSlug: string;
  tenantSlug: string;
  organizationId: string;
  tier?: TenantActivationRecord['tier'];
  reason: string;
  rootDir?: string;
  accept: boolean;
}): TenantActivationRecord {
  if (!input.accept) throw new Error('Human acceptance is required before tenant suspension.');
  const rootDir = input.rootDir || pathResolver.rootDir();
  const current = loadTenantActivation(input, rootDir);
  if (!current)
    throw new Error(
      `No tenant activation receipt for '${input.customerSlug}/${input.tenantSlug}'.`
    );
  const revokedTaskGrants = revokeGrantsForTenantBestEffort(
    current.tenant_slug,
    `tenant '${current.tenant_slug}' activation suspended: ${input.reason}`
  );
  return writeActivationRecord(
    {
      ...current,
      status: 'suspended',
      blockers: [...new Set([...current.blockers, `suspended: ${input.reason}`])],
      revoked_task_grants: revokedTaskGrants,
      updated_at: new Date().toISOString(),
    },
    rootDir
  );
}

export function isTenantActivationActive(
  input: TenantActivationScope,
  rootDir = pathResolver.rootDir()
): boolean {
  const record = loadTenantActivation(input, rootDir);
  if (!record || record.status !== 'active' || record.blockers.length > 0) return false;
  const current = buildChecks(
    {
      ...input,
      ownerId: record.owner_id,
      nhiIds: record.nhi_ids,
      checks: record.checks,
      probeRefs: record.probe_refs,
      rootDir,
    },
    record.nhi_ids
  );
  return (
    current.blockers.length === 0 &&
    TENANT_ACTIVATION_CHECKS.every((check) => current.checks[check])
  );
}
