import { createHash, timingSafeEqual } from 'node:crypto';

import { isValidTenantSlug } from './entity-scope.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { secretGuard } from './secret-guard.js';

const SCOPE_ID_PATTERN = /^[^\s/]+$/u;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const REGISTRY_PATH = pathResolver.knowledge('personal/connections/chronos-access.json');

export type ChronosAccessRole = 'readonly' | 'localadmin';

export interface ChronosTokenRegistration {
  token_hash: string;
  role: ChronosAccessRole;
  tenant_slugs: string[];
  organization_ids?: string[];
  project_ids?: string[];
  tier_access?: OsKnowledgeTier[];
  label?: string;
}

function isScopeId(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_ID_PATTERN.test(value);
}

export function isValidChronosScopeId(value: string): boolean {
  return isScopeId(value);
}

function hasTokenList(document: unknown): document is { tokens: unknown[] } {
  return (
    typeof document === 'object' &&
    document !== null &&
    !Array.isArray(document) &&
    'tokens' in document &&
    Array.isArray(document.tokens)
  );
}

function isTier(value: unknown): value is OsKnowledgeTier {
  return value === 'public' || value === 'confidential' || value === 'personal';
}

export function parseChronosTokenRegistrations(document: unknown): ChronosTokenRegistration[] {
  if (!hasTokenList(document)) {
    throw new Error('chronos access registry must contain tokens');
  }

  return document.tokens.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid chronos access entry');
    const value = entry as Record<string, unknown>;
    const organizationIds = value.organization_ids;
    const projectIds = value.project_ids;
    const tierAccess = value.tier_access;
    if (
      typeof value.token_hash !== 'string' ||
      !TOKEN_HASH_PATTERN.test(value.token_hash) ||
      (value.role !== 'readonly' && value.role !== 'localadmin') ||
      !Array.isArray(value.tenant_slugs) ||
      !value.tenant_slugs.every(
        (tenant) => typeof tenant === 'string' && isValidTenantSlug(tenant.trim())
      ) ||
      (organizationIds !== undefined &&
        (!Array.isArray(organizationIds) ||
          !organizationIds.every(
            (organization) => typeof organization === 'string' && isScopeId(organization.trim())
          ))) ||
      (projectIds !== undefined &&
        (!Array.isArray(projectIds) ||
          !projectIds.every(
            (project) => typeof project === 'string' && isScopeId(project.trim())
          ))) ||
      (tierAccess !== undefined &&
        (!Array.isArray(tierAccess) || tierAccess.length === 0 || !tierAccess.every(isTier)))
    ) {
      throw new Error('invalid chronos access entry');
    }

    return {
      token_hash: value.token_hash,
      role: value.role,
      tenant_slugs: value.tenant_slugs.map((tenant) => tenant.trim()),
      ...(Array.isArray(organizationIds)
        ? { organization_ids: organizationIds.map((organization) => organization.trim()) }
        : {}),
      ...(Array.isArray(projectIds)
        ? { project_ids: projectIds.map((project) => project.trim()) }
        : {}),
      ...(Array.isArray(tierAccess) ? { tier_access: tierAccess.filter(isTier) } : {}),
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
    } as ChronosTokenRegistration;
  });
}

/** Read the registry with strict parsing; callers choose their failure policy. */
export function readChronosTokenRegistrations(): ChronosTokenRegistration[] | null {
  if (!safeExistsSync(REGISTRY_PATH)) return null;
  return parseChronosTokenRegistrations(secretGuard.loadConnectionDocument('chronos-access'));
}

export function matchesChronosToken(candidate: string, configured: string | undefined): boolean {
  if (!candidate || !configured) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function findChronosTokenRegistration(
  token: string,
  registrations: ChronosTokenRegistration[]
): ChronosTokenRegistration | null {
  const digest = createHash('sha256').update(token).digest('hex');
  return registrations.find((entry) => matchesChronosToken(digest, entry.token_hash)) || null;
}
