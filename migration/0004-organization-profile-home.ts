/**
 * Concept model v2 D3 (Tenant 1:N Organization): organization profiles are
 * stored per organization. Move each tenant's legacy tenant-root profile,
 * `knowledge/confidential/{tenant}/organization-profile.json`, to its
 * organization, `knowledge/confidential/{tenant}/organizations/{org}/organization-profile.json`,
 * where `{org}` is the profile's own `organization_id`. Run after 0002-tenant-home.
 *
 * Run with `pnpm migration --dry-run` first: it prints every move and writes
 * nothing. An existing target is never overwritten; that tenant is reported
 * and left in place (the loader keeps reading the legacy file for one
 * release). Re-running is a no-op once every profile moved.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { readJsonIfPresent } from '@agent/core/foundation';
import { isValidTenantSlug } from '@agent/core/foundation/scope';
import {
  ORGANIZATION_PROFILE_FILE,
  TENANT_ORGANIZATIONS_DIR,
} from '@agent/core/organization/organization-profile';
import { TENANT_HOME_ROOT } from '@agent/core/organization/tenant-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeReaddir,
} from '@agent/core/secure-io';

export const id = '0004-organization-profile-home';
export const description =
  'Move knowledge/confidential/{tenant}/organization-profile.json to organizations/{org}/organization-profile.json';
export const introduced_in = 'concept model v2 (S3)';

const ORGANIZATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface OrganizationProfileMove {
  tenant: string;
  organizationId: string;
  from: string;
  to: string;
}

export interface OrganizationProfileSkip {
  tenant: string;
  from: string;
  reason: 'target_exists' | 'invalid_organization_id';
}

function rel(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function safe(target: string, root: string): string {
  return assertSafeRepositoryPath(target, { allowMissingLeaf: true, rootDir: root });
}

/** Read-only plan for every tenant home under `root`. */
export function planOrganizationProfileMoves(root: string = pathResolver.rootDir()): {
  moves: OrganizationProfileMove[];
  skipped: OrganizationProfileSkip[];
} {
  const moves: OrganizationProfileMove[] = [];
  const skipped: OrganizationProfileSkip[] = [];
  const homeRoot = safe(path.join(root, TENANT_HOME_ROOT), root);
  const tenants = withExecutionContext('onboarding', () =>
    safeExistsSync(homeRoot) ? safeReaddir(homeRoot).sort() : []
  ).filter((tenant) => isValidTenantSlug(tenant));
  for (const tenant of tenants) {
    // Each tenant home is read inside that tenant's own scope (tenant isolation).
    withExecutionContext(
      'onboarding',
      () => planTenant(root, homeRoot, tenant, moves, skipped),
      undefined,
      tenant
    );
  }
  return { moves, skipped };
}

function planTenant(
  root: string,
  homeRoot: string,
  tenant: string,
  moves: OrganizationProfileMove[],
  skipped: OrganizationProfileSkip[]
): void {
  {
    const home = safe(path.join(homeRoot, tenant), root);
    if (!safeLstat(home).isDirectory()) return;
    const from = safe(path.join(home, ORGANIZATION_PROFILE_FILE), root);
    if (!safeExistsSync(from) || !safeLstat(from).isFile()) return;
    const profile = readJsonIfPresent<Record<string, unknown>>(from);
    const organizationId =
      typeof profile?.organization_id === 'string' ? profile.organization_id.trim() : '';
    if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
      skipped.push({ tenant, from, reason: 'invalid_organization_id' });
      return;
    }
    const to = safe(
      path.join(home, TENANT_ORGANIZATIONS_DIR, organizationId, ORGANIZATION_PROFILE_FILE),
      root
    );
    if (safeExistsSync(to)) {
      skipped.push({ tenant, from, reason: 'target_exists' });
      return;
    }
    moves.push({ tenant, organizationId, from, to });
  }
}

export async function migrate(opts: { dryRun: boolean }): Promise<void> {
  const root = pathResolver.rootDir();
  const { moves, skipped } = planOrganizationProfileMoves(root);
  for (const skip of skipped) {
    logger.warn(
      `[${id}] left ${rel(root, skip.from)} in place — ${skip.reason} | next: ${
        skip.reason === 'target_exists'
          ? 'merge the two profiles by hand'
          : 'set a valid organization_id in the profile'
      }`
    );
  }
  if (moves.length === 0) {
    logger.info(`[${id}] no legacy tenant-root organization profile — nothing to migrate`);
    return;
  }
  // `onboarding` is the governed writer of company files in the tenant home,
  // bound to each tenant in turn.
  for (const move of moves) {
    logger.info(
      `[${id}] ${opts.dryRun ? 'would move' : 'move'} ${rel(root, move.from)} -> ${rel(root, move.to)}`
    );
    if (opts.dryRun) continue;
    withExecutionContext(
      'onboarding',
      () => {
        safeMkdir(path.dirname(move.to), { recursive: true });
        safeMoveSync(move.from, move.to);
      },
      undefined,
      move.tenant
    );
  }
}
