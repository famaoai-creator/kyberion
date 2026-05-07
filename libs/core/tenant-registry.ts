import * as path from 'node:path';
import AjvModule from 'ajv';
import { customerIsConfigured, customerRoot } from './customer-resolver.js';
import * as pathResolver from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
const TENANT_GROUP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const TENANT_GROUP_SCHEMA_PATH = pathResolver.rootResolve('schemas/tenant-group.schema.json');
const tenantGroupValidate = compileSchemaFromPath(ajv, TENANT_GROUP_SCHEMA_PATH);

export interface TenantProfile {
  tenant_slug: string;
  tenant_id?: string;
  display_name: string;
  status: 'active' | 'suspended' | 'archived';
  assigned_role: string;
  isolation_policy?: {
    strict_isolation?: boolean;
    allow_cross_distillation?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface TenantGroupProfile {
  tenant_group_id: string;
  display_name: string;
  status: 'active' | 'suspended' | 'archived';
  member_tenants: string[];
  shared_prefixes: string[];
  purpose?: string;
  metadata?: Record<string, unknown>;
}

function assertTenantSlug(slug: string): void {
  if (!TENANT_SLUG_RE.test(slug)) {
    throw new Error(`[tenant-registry] invalid tenant slug '${slug}'`);
  }
}

function assertTenantGroupId(groupId: string): void {
  if (!TENANT_GROUP_ID_RE.test(groupId)) {
    throw new Error(`[tenant-registry] invalid tenant group id '${groupId}'`);
  }
}

function assertTenantGroupProfile(profile: TenantGroupProfile): void {
  const groupId = profile.tenant_group_id;
  const ok = tenantGroupValidate(profile);
  if (ok) return;
  const details = (tenantGroupValidate.errors || [])
    .map((err) => `${err.instancePath || '/'} ${err.message || 'schema violation'}`)
    .join('; ');
  throw new Error(`[tenant-registry] invalid tenant group profile '${groupId}': ${details}`);
}

export function tenantProfileDir(): string {
  if (customerIsConfigured()) {
    const root = customerRoot('tenants');
    if (root) return root;
  }
  return pathResolver.knowledge('personal/tenants');
}

export function tenantProfilePath(slug: string): string {
  assertTenantSlug(slug);
  return path.join(tenantProfileDir(), `${slug}.json`);
}

export function tenantGroupDir(): string {
  return pathResolver.knowledge('confidential/tenant-groups');
}

export function tenantGroupPath(groupId: string): string {
  assertTenantGroupId(groupId);
  return path.join(tenantGroupDir(), `${groupId}.json`);
}

export function ensureDefaultTenantProfile(): TenantProfile {
  const file = tenantProfilePath('default');
  if (safeExistsSync(file)) {
    return JSON.parse(safeReadFile(file, { encoding: 'utf8' }) as string) as TenantProfile;
  }

  const now = new Date().toISOString();
  const profile: TenantProfile = {
    tenant_slug: 'default',
    tenant_id: 'default',
    display_name: 'Default Tenant',
    status: 'active',
    assigned_role: 'owner',
    isolation_policy: {
      strict_isolation: true,
      allow_cross_distillation: true,
    },
    metadata: {
      bootstrap_source: 'tenant-registry.ensureDefaultTenantProfile',
      created_at: now,
    },
  };

  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(profile, null, 2) + '\n', { encoding: 'utf8' });
  return profile;
}

export function writeTenantGroupProfile(group: TenantGroupProfile): TenantGroupProfile {
  assertTenantGroupId(group.tenant_group_id);
  const normalizedMembers = Array.from(new Set(group.member_tenants));
  for (const tenant of normalizedMembers) assertTenantSlug(tenant);
  const normalizedPrefixes = Array.from(
    new Set(
      group.shared_prefixes.length > 0
        ? group.shared_prefixes
        : [`knowledge/confidential/shared/${group.tenant_group_id}/`],
    ),
  );

  const normalized: TenantGroupProfile = {
    ...group,
    member_tenants: normalizedMembers,
    shared_prefixes: normalizedPrefixes,
  };
  assertTenantGroupProfile(normalized);

  const file = tenantGroupPath(group.tenant_group_id);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8' });
  return normalized;
}
