import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  DEFAULT_TENANT_ISOLATION_POLICY,
  defaultTenantKnowledgeRoot,
  listTenantProfileSlugs,
  readTenantProfile,
  recordTenantProviderAttestation,
  tenantProfilePath,
  writeTenantProfile,
  type RecordProviderAttestationInput,
  type TenantProfile,
  type TenantRegistryPathOptions,
} from './tenant-registry.js';
import { loadProviderEgressPolicy } from '../provider/provider-egress-gate.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';

export type TenantLifecycleVerb = 'create' | 'update' | 'suspend' | 'resume' | 'archive';

export interface TenantMutationInput extends TenantRegistryPathOptions {
  verb: TenantLifecycleVerb;
  slug: string;
  displayName?: string;
  assignedRole?: string;
  knowledgeRoot?: string;
  metadata?: Record<string, unknown>;
  apply?: boolean;
  actor?: string;
}

export interface TenantMutationResult {
  status: 'dry-run' | 'applied';
  verb: TenantLifecycleVerb;
  profile: TenantProfile;
  profile_path: string;
  knowledge_root_path: string;
}

function assertOperational(profile: TenantProfile, verb: TenantLifecycleVerb): void {
  if (profile.status === 'archived') {
    throw new Error(`Tenant '${profile.tenant_slug}' is archived and cannot be mutated (${verb}).`);
  }
  if (verb === 'resume' && profile.status !== 'suspended') {
    throw new Error(`Tenant '${profile.tenant_slug}' is not suspended.`);
  }
  if (verb === 'suspend' && profile.status !== 'active') {
    throw new Error(`Tenant '${profile.tenant_slug}' is not active.`);
  }
}

function buildProfile(input: TenantMutationInput, current: TenantProfile | null): TenantProfile {
  const slug = input.slug.trim();
  const profile: TenantProfile = {
    tenant_slug: slug,
    tenant_id: current?.tenant_id || slug,
    display_name: input.displayName?.trim() || current?.display_name || slug,
    status:
      input.verb === 'suspend'
        ? 'suspended'
        : input.verb === 'archive'
          ? 'archived'
          : input.verb === 'resume'
            ? 'active'
            : current?.status || 'active',
    assigned_role: input.assignedRole?.trim() || current?.assigned_role || 'owner',
    knowledge_root:
      input.knowledgeRoot?.trim() || current?.knowledge_root || defaultTenantKnowledgeRoot(slug),
    // New tenants start strictly isolated (the same default as the bootstrap
    // `default` tenant): tenant activation's memory_policy check requires it,
    // and no CLI flag exists to set it afterwards without editing the registry.
    ...(current?.isolation_policy
      ? { isolation_policy: current.isolation_policy }
      : input.verb === 'create'
        ? { isolation_policy: { ...DEFAULT_TENANT_ISOLATION_POLICY } }
        : {}),
    ...(current?.allowed_reasoning_backends
      ? { allowed_reasoning_backends: current.allowed_reasoning_backends }
      : {}),
    ...(current?.provider_attestations
      ? { provider_attestations: current.provider_attestations }
      : {}),
    ...(current?.ingest_sources ? { ingest_sources: current.ingest_sources } : {}),
    ...(input.metadata || current?.metadata
      ? { metadata: { ...(current?.metadata || {}), ...(input.metadata || {}) } }
      : {}),
  };
  return profile;
}

export function mutateTenant(input: TenantMutationInput): TenantMutationResult {
  const options: TenantRegistryPathOptions = { rootDir: input.rootDir, env: input.env };
  const current = readTenantProfile(input.slug, options);
  if (input.verb === 'create' && current) {
    throw new Error(`Tenant '${input.slug}' already exists.`);
  }
  if (input.verb !== 'create' && !current) {
    throw new Error(`Tenant '${input.slug}' does not exist.`);
  }
  if (current) assertOperational(current, input.verb);
  const profile = buildProfile(input, current);
  const profilePath = tenantProfilePath(profile.tenant_slug, options);
  const knowledgeRootPath = path.resolve(
    input.rootDir ?? pathResolver.rootDir(),
    profile.knowledge_root!
  );
  if (input.apply) {
    const saved = writeTenantProfile(profile, options);
    if (!safeExistsSync(knowledgeRootPath)) safeMkdir(knowledgeRootPath, { recursive: true });
    auditChain.record({
      agentId: input.actor || getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
      action: `tenant.${input.verb}`,
      operation: `tenant:${profile.tenant_slug}`,
      result: 'completed',
      tenantSlug: profile.tenant_slug,
      metadata: { status: saved.status, knowledge_root: saved.knowledge_root },
    });
    return {
      status: 'applied',
      verb: input.verb,
      profile: saved,
      profile_path: profilePath,
      knowledge_root_path: knowledgeRootPath,
    };
  }
  return {
    status: 'dry-run',
    verb: input.verb,
    profile,
    profile_path: profilePath,
    knowledge_root_path: knowledgeRootPath,
  };
}

export function listTenants(options: TenantRegistryPathOptions = {}): TenantProfile[] {
  return listTenantProfileSlugs(options)
    .map((slug) => readTenantProfile(slug, options))
    .filter((profile): profile is TenantProfile => Boolean(profile));
}

export function showTenant(slug: string, options: TenantRegistryPathOptions = {}): TenantProfile {
  const profile = readTenantProfile(slug, options);
  if (!profile) throw new Error(`Tenant '${slug}' does not exist.`);
  return profile;
}

export interface TenantProviderAttestationResult {
  slug: string;
  provider: string;
  attestation: NonNullable<TenantProfile['provider_attestations']>[string];
  profile_path: string;
}

/**
 * Governed entry point for recording a tenant provider attestation — shared by
 * `pnpm tenant attest-provider` and `pnpm onboarding llm attest`.
 *
 * Only providers declared in provider-egress-policy.json can be attested: the
 * gate never lets an attestation invent an egress identity, so recording one
 * for an unknown id would only produce a claim that silently does nothing.
 * Every attestation is written to the audit chain (action
 * `tenant.attest_provider`), because it is what lets confidential material
 * leave the machine.
 */
export function attestTenantProvider(
  input: RecordProviderAttestationInput & { actor?: string }
): TenantProviderAttestationResult {
  const provider = input.provider?.trim();
  if (!provider) throw new Error('[tenant-governance] provider is required.');
  const loaded = loadProviderEgressPolicy();
  if (loaded.status !== 'ok') {
    throw new Error(
      `[tenant-governance] provider-egress-policy.json is ${loaded.status}; cannot verify provider '${provider}'.`
    );
  }
  const known = Object.keys(loaded.policy.providers).sort();
  if (!known.includes(provider)) {
    throw new Error(
      `[tenant-governance] unknown provider '${provider}'. Declared providers: ${known.join(', ')}.`
    );
  }
  const profile = recordTenantProviderAttestation({ ...input, provider });
  const attestation = profile.provider_attestations![provider]!;
  const options: TenantRegistryPathOptions = input.rootDir ? { rootDir: input.rootDir } : {};
  auditChain.record({
    agentId: input.actor || getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
    action: 'tenant.attest_provider',
    operation: `tenant:${profile.tenant_slug}:provider:${provider}`,
    result: 'completed',
    tenantSlug: profile.tenant_slug,
    metadata: {
      provider,
      training_use: attestation.training_use,
      ...(attestation.plan ? { plan: attestation.plan } : {}),
      ...(attestation.basis ? { basis: attestation.basis } : {}),
      ...(attestation.attested_by ? { attested_by: attestation.attested_by } : {}),
      ...(attestation.expires_at ? { expires_at: attestation.expires_at } : {}),
    },
  });
  return {
    slug: profile.tenant_slug,
    provider,
    attestation,
    profile_path: tenantProfilePath(profile.tenant_slug, options),
  };
}
