/**
 * Path → data tier / owning tenant attribution.
 *
 * Classifies a path by where its bytes really live (symlinks resolved) and
 * names the tier partition and the owning tenant. Used by every scope check
 * that must attribute an input file (perception, semantic index, vision, video
 * ingest). Fails closed: a non-public path whose owner cannot be determined
 * throws `PathAttributionError('TENANT_UNRESOLVED')`.
 */
import type { StorageDataTier } from '../storage-layout.js';
import * as path from 'node:path';
import { isValidTenantSlug } from '../entity-scope.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRealpath } from '../secure-io.js';
import { isSharedConfidentialOwner } from './shared-scope-prefixes.js';

export type PathDataTier = StorageDataTier;
export type PathAttributionFailureCode = 'TIER_UNRESOLVED' | 'TENANT_UNRESOLVED';

export class PathAttributionError extends Error {
  constructor(
    readonly code: PathAttributionFailureCode,
    /** The failure without the `[CODE]` prefix, for callers that re-wrap it. */
    readonly detail: string
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'PathAttributionError';
  }
}

export interface ClassifiedPath {
  /** Canonical repo-relative path (symlinks resolved), original case. */
  rel: string;
  /** `rel` lower-cased: tier and tenant partitions match case-insensitively. */
  lower: string;
}

/** Canonical path; unresolvable symlinks and anything outside the repository fail closed. */
export function canonicalRepoPath(filePath: string): string {
  try {
    return safeRealpath(path.resolve(pathResolver.rootDir(), filePath));
  } catch (error) {
    throw new PathAttributionError('TIER_UNRESOLVED', (error as Error).message);
  }
}

/** Classify by where the bytes really live: symlinks (also in parents) resolved. */
export function classifyRepoPath(filePath: string): ClassifiedPath {
  const rel = path
    .relative(canonicalRepoPath(pathResolver.rootDir()), canonicalRepoPath(filePath))
    .split(path.sep)
    .join('/');
  return { rel, lower: rel.toLowerCase() };
}

/** Data tier implied by where a path lives (knowledge/ or active/ tier partitions). */
export function tierOfPath(filePath: string): PathDataTier {
  return tierOfClassified(classifyRepoPath(filePath).lower);
}

function tierOfClassified(lower: string): PathDataTier {
  const match =
    /^knowledge\/(personal|confidential|public)(?:\/|$)/.exec(lower) ??
    /^active\/(?:missions|projects|organizations)\/(personal|confidential|public)(?:\/|$)/.exec(
      lower
    );
  if (match) return match[1] as PathDataTier;
  if (/^(?:active\/personal|vault)(?:\/|$)/.test(lower)) return 'personal';
  return 'public';
}

/** `knowledge/confidential/<segment>` shared owners derive from security-policy
 * `tenant_scope.shared_prefixes` via shared-scope-prefixes.ts — never a tenant. */

/** Workspace segment of tenant-less trees (`active/{projects,organizations,missions}/{tier}/shared/`). */
const SHARED_WORKSPACE_SEGMENT = 'shared';

type MissionStateTenant =
  | { state: 'absent' }
  | { state: 'tenantless' }
  | { state: 'tenant'; slug: string }
  | { state: 'unreadable' };

function missionStateTenant(missionDir: string): MissionStateTenant {
  const statePath = path.join(missionDir, 'mission-state.json');
  if (!safeExistsSync(statePath)) return { state: 'absent' };
  try {
    const state = parseSafeJsonInput(
      safeReadFile(statePath, { encoding: 'utf8' }) as string,
      'mission state'
    );
    if (!state || typeof state !== 'object') return { state: 'unreadable' };
    const record = state as Record<string, unknown>;
    const slug = record.tenant_slug ?? record.tenant_id;
    if (slug === undefined || slug === null || slug === '') return { state: 'tenantless' };
    return typeof slug === 'string' && isValidTenantSlug(slug)
      ? { state: 'tenant', slug }
      : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

function tenantUnresolved(rel: string, why: string): PathAttributionError {
  return new PathAttributionError(
    'TENANT_UNRESOLVED',
    `cannot attribute ${rel} to a tenant: ${why}`
  );
}

/**
 * Tenant owning a path: `knowledge/confidential/{slug}/`, the tenant-scoped
 * trees `active/{projects,organizations}/{tier}/{slug}/`, a tenant-scoped
 * mission directory `active/missions/{tier}/{slug}/{mission}/`, or the tenant
 * recorded in a mission's state (`active/missions/{tier}/{mission}/`). The
 * `shared` workspace segment and the shared knowledge prefixes have no tenant.
 *
 * Fails closed (TENANT_UNRESOLVED) for any non-public path whose owner cannot
 * be determined, so an unknown owner never passes the same-tenant check.
 */
export function tenantOfPath(filePath: string): string | undefined {
  const { rel, lower } = classifyRepoPath(filePath);
  const scoped = tierOfClassified(lower) !== 'public';
  const parts = lower.split('/');
  const original = rel.split('/');
  if (parts[0] === 'knowledge' && parts[1] === 'confidential') {
    const slug = parts[2];
    if (slug && isSharedConfidentialOwner(slug)) return undefined;
    if (slug && isValidTenantSlug(slug)) return slug;
    throw tenantUnresolved(rel, 'not under a tenant or shared prefix');
  }
  const tree = parts[1];
  const tier = parts[2];
  const tenantTree =
    parts[0] === 'active' &&
    (tree === 'projects' || tree === 'organizations' || tree === 'missions') &&
    (tier === 'personal' || tier === 'confidential' || tier === 'public');
  if (!tenantTree) {
    if (scoped) throw tenantUnresolved(rel, 'not inside a tenant-scoped partition');
    return undefined;
  }
  const segment = parts[3];
  if (!segment) {
    if (scoped) throw tenantUnresolved(rel, 'no tenant segment');
    return undefined;
  }
  if (tree !== 'missions') {
    if (segment === SHARED_WORKSPACE_SEGMENT) return undefined;
    if (isValidTenantSlug(segment)) return segment;
    if (scoped) throw tenantUnresolved(rel, `'${original[3]}' is not a tenant slug`);
    return undefined;
  }
  return missionTenant(rel, original, scoped);
}

/** `active/missions/{tier}/{mission | slug/mission | shared/mission}/…`. */
function missionTenant(rel: string, original: string[], scoped: boolean): string | undefined {
  const segment = original[3].toLowerCase();
  const segmentDir = path.join(canonicalRepoPath(pathResolver.rootDir()), ...original.slice(0, 4));
  const recorded = missionStateTenant(segmentDir);
  if (recorded.state === 'tenant') return recorded.slug;
  if (recorded.state === 'tenantless') return undefined;
  if (recorded.state === 'unreadable') {
    if (scoped) throw tenantUnresolved(rel, 'mission state has no readable tenant');
    return undefined;
  }
  const shared = segment === SHARED_WORKSPACE_SEGMENT;
  if (!shared && !isValidTenantSlug(segment)) {
    if (scoped)
      throw tenantUnresolved(rel, `'${original[3]}' is neither a mission nor a tenant slug`);
    return undefined;
  }
  const partitionTenant = shared ? undefined : segment;
  // A mission nested in a tenant (or shared) partition must not claim another tenant.
  const nested = original[4]
    ? missionStateTenant(path.join(segmentDir, original[4]))
    : ({ state: 'absent' } as const);
  if (nested.state === 'unreadable') {
    throw tenantUnresolved(rel, 'mission state has no readable tenant');
  }
  if (nested.state === 'tenant' && nested.slug !== partitionTenant) {
    if (shared) return nested.slug;
    throw tenantUnresolved(
      rel,
      `mission state names tenant '${nested.slug}' inside the '${segment}' partition`
    );
  }
  return partitionTenant;
}
