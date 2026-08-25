import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { auditChain } from './audit-chain.js';
import {
  defaultTenantKnowledgeRoot,
  listTenantProfileSlugs,
  readTenantProfile,
  tenantProfilePath,
  writeTenantProfile,
  type TenantProfile,
  type TenantRegistryPathOptions,
} from './tenant-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir } from './secure-io.js';

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
    ...(current?.isolation_policy ? { isolation_policy: current.isolation_policy } : {}),
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
