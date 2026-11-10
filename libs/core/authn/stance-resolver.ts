import * as path from 'node:path';
import { rawExistsSync } from '../fs-primitives.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import {
  LEGACY_STANCE_ENV_VAR,
  STANCE_ENV_VAR,
  STANCE_SLUG_PATTERN,
  STANCES_DIR,
  __stanceEnvTest__,
  stanceSlugFromEnv,
} from './stance-env.js';

/**
 * Stance Resolver
 *
 * A stance is the acting-for selection (Concept Model v2 D4): which tenant an
 * operator — a human or an agent, typically an FDE serving several customers —
 * is acting for right now, as which Organization and Org Role. It is chosen
 * from the tenants the operator is permitted to serve; selecting any other
 * tenant is rejected, and switching it switches the data scope (see
 * `narrowViewerScopeToStance` and `stanceResourceBinding`).
 *
 * A stance is the operator's own configuration (custody `person`), so its
 * directory lives under the operator's personal space and overlays
 * `knowledge/personal/`:
 *
 *   knowledge/personal/stances/{slug}/{subPath}  →  knowledge/personal/{subPath}
 *
 * `stance.json` declares the selection (`acting_for`). The active stance is
 * named by `KYBERION_STANCE`. Customer communication (tone, contact window,
 * route) is not part of a stance: it belongs to the tenant's channel bindings
 * and customer records under `knowledge/confidential/{tenant}/`.
 */

export { LEGACY_STANCE_ENV_VAR, STANCE_ENV_VAR, STANCES_DIR };
const SLUG_PATTERN = STANCE_SLUG_PATTERN;
/** Organization ids follow the Chronos scope id grammar. */
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** Org Role ids are the role directory names under `knowledge/product/roles/`. */
const ORG_ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export class InvalidStanceSlugError extends Error {
  constructor(slug: string) {
    super(
      `Invalid ${STANCE_ENV_VAR}: "${slug}". Must match ${SLUG_PATTERN.source} ` +
        `(lowercase ASCII, digits, hyphen, underscore; must start with letter or digit).`
    );
    this.name = 'InvalidStanceSlugError';
  }
}

/** The active stance slug, or null when Kyberion acts from `knowledge/personal/` alone. */
export function activeStance(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): string | null {
  const slug = stanceSlugFromEnv(env, rootDir);
  if (!slug) return null;
  if (!SLUG_PATTERN.test(slug)) throw new InvalidStanceSlugError(slug);
  return slug;
}

/** What an operator acts as under a stance: one tenant, optionally one Org and Org Role in it. */
export interface StanceSelection {
  readonly tenantSlug: string;
  readonly organizationId?: string;
  readonly orgRole?: string;
}

/** A selection checked against the tenants the operator may serve. */
export interface ResolvedStance {
  /** The tenants the operator may act for (`'all'` only for an unbound local operator). */
  readonly permittedTenants: readonly string[] | 'all';
  readonly selected: StanceSelection;
}

export class InvalidStanceSelectionError extends Error {
  constructor(message: string) {
    super(`[STANCE_SELECTION_INVALID] ${message}`);
    this.name = 'InvalidStanceSelectionError';
  }
}

export class StanceNotPermittedError extends Error {
  constructor(kind: 'tenant' | 'organization', value: string) {
    super(`[STANCE_NOT_PERMITTED] the operator is not permitted to act for ${kind} '${value}'`);
    this.name = 'StanceNotPermittedError';
  }
}

function validSelection(selection: StanceSelection): StanceSelection {
  const tenantSlug = typeof selection?.tenantSlug === 'string' ? selection.tenantSlug.trim() : '';
  if (!isValidTenantSlug(tenantSlug))
    throw new InvalidStanceSelectionError(`invalid tenant slug '${tenantSlug}'`);
  const organizationId = selection.organizationId?.trim() || undefined;
  if (organizationId !== undefined && !ORGANIZATION_ID_PATTERN.test(organizationId))
    throw new InvalidStanceSelectionError(`invalid organization id '${organizationId}'`);
  const orgRole = selection.orgRole?.trim() || undefined;
  if (orgRole !== undefined && !ORG_ROLE_PATTERN.test(orgRole))
    throw new InvalidStanceSelectionError(`invalid Org Role '${orgRole}'`);
  return Object.freeze({
    tenantSlug,
    ...(organizationId ? { organizationId } : {}),
    ...(orgRole ? { orgRole } : {}),
  });
}

/**
 * Check a selection against the operator's permitted tenants. A tenant outside
 * that list is rejected; the permitted list itself is server-side authority
 * (tenant registry, viewer registration) and is never taken from the request.
 */
export function resolveStance(input: {
  permittedTenants: readonly string[] | 'all';
  selection: StanceSelection;
}): ResolvedStance {
  const selected = validSelection(input.selection);
  const permitted =
    input.permittedTenants === 'all'
      ? 'all'
      : Object.freeze([...new Set(input.permittedTenants.filter(isValidTenantSlug))]);
  if (permitted !== 'all' && !permitted.includes(selected.tenantSlug))
    throw new StanceNotPermittedError('tenant', selected.tenantSlug);
  return Object.freeze({ permittedTenants: permitted, selected });
}

/**
 * Narrow a viewer scope (`SurfaceViewerScope` / `ViewerContext`) to the
 * stance's tenant and organization. It only ever narrows: a tenant or
 * organization the viewer is not already allowed is rejected, so a stance
 * cannot widen what the credential grants.
 */
export function narrowViewerScopeToStance<
  V extends { tenantSlugs: string[] | 'all'; organizationIds?: string[] | 'all' },
>(viewer: V, selection: StanceSelection): V {
  const stance = resolveStance({ permittedTenants: viewer.tenantSlugs, selection }).selected;
  const { organizationId } = stance;
  const allowedOrganizations = viewer.organizationIds ?? 'all';
  if (
    organizationId &&
    allowedOrganizations !== 'all' &&
    !allowedOrganizations.includes(organizationId)
  )
    throw new StanceNotPermittedError('organization', organizationId);
  return {
    ...viewer,
    tenantSlugs: [stance.tenantSlug],
    organizationIds: organizationId ? [organizationId] : viewer.organizationIds,
  };
}

/**
 * The tenant binding a `ResourceAccessScope` takes under a stance. Spread it
 * into the scope; nested scopes cannot change it (`runInResourceAccessScope`).
 */
export function stanceResourceBinding(stance: ResolvedStance): {
  custody: { kind: 'tenant' };
  tenantSlug: string;
  organizationId?: string;
} {
  return {
    custody: { kind: 'tenant' },
    tenantSlug: stance.selected.tenantSlug,
    ...(stance.selected.organizationId ? { organizationId: stance.selected.organizationId } : {}),
  };
}

/**
 * The selection a stance declares in `stance.json` (`acting_for`), or null when
 * it declares none. Malformed declarations throw rather than act for no one.
 */
export function parseStanceSelection(stanceJson: unknown): StanceSelection | null {
  if (!stanceJson || typeof stanceJson !== 'object') return null;
  const actingFor = (stanceJson as { acting_for?: unknown }).acting_for;
  if (actingFor === undefined || actingFor === null) return null;
  if (typeof actingFor !== 'object')
    throw new InvalidStanceSelectionError('acting_for must be an object');
  const record = actingFor as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string')
      throw new InvalidStanceSelectionError(`acting_for.${key} must be a string`);
    return value;
  };
  return validSelection({
    tenantSlug: text('tenant_slug') ?? '',
    organizationId: text('organization_id'),
    orgRole: text('org_role'),
  });
}

/** Directory of one stance (it may not exist yet). */
export function stanceDirForSlug(slug: string, rootDir: string = pathResolver.rootDir()): string {
  if (!SLUG_PATTERN.test(slug)) throw new InvalidStanceSlugError(slug);
  return assertSafeRepositoryPath(path.join(rootDir, STANCES_DIR, slug), {
    allowMissingLeaf: true,
    rootDir,
  });
}

/**
 * Path under the active stance, or null when no stance is active. Refuses a
 * subPath that escapes the stance directory.
 */
export function stanceRoot(
  subPath = '',
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): string | null {
  const slug = activeStance(env, rootDir);
  if (!slug) return null;
  const base = path.join(rootDir, STANCES_DIR, slug);
  const candidate = subPath ? path.resolve(base, subPath) : base;
  if (!pathResolver.isPathInsideOrEqual(base, candidate)) {
    throw new Error(`[STANCE_SCOPE] stance overlay path escapes stance '${slug}': ${subPath}`);
  }
  return assertSafeRepositoryPath(candidate, {
    allowMissingLeaf: true,
    rootDir,
  });
}

/**
 * Top-level entries of a stance directory: the files and folders read through
 * the stance overlay. Anything else that legacy `customer/{slug}/` held (company
 * profile, vision, org chart, OKRs, decision rights, brand, design, deals, the
 * audit mirror, channel bindings) belongs to a tenant, not to a stance
 * (`organization/tenant-home.ts`).
 */
export const STANCE_ENTRIES: readonly string[] = [
  'identity.json',
  'my-identity.json',
  'agent-identity.json',
  'my-vision.md',
  'policy',
  'connections',
  'voice',
  'mission-seeds',
  'tenants',
  'onboarding',
];
/** Entries under a stance entry that belong to the tenant instead (relative paths). */
export const NON_STANCE_ENTRIES: readonly string[] = ['connections/channel-bindings.json'];

/** Whether a path relative to a legacy `customer/{slug}/` directory is stance configuration. */
export function isStanceEntry(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/').replace(/^\.\//u, '');
  if (NON_STANCE_ENTRIES.includes(normalized)) return false;
  return STANCE_ENTRIES.includes(normalized.split('/')[0]);
}

/** Repository-relative directory of logs written while acting under a stance. */
export const STANCE_LOGS_DIR = path.join('active', 'shared', 'logs', 'stances');

/**
 * Where run logs of the active stance go (`active/shared/logs/stances/{slug}/{kind}`),
 * or null when no stance is active. Logs are runtime output, not stance
 * configuration, so they stay out of `knowledge/`.
 */
export function stanceLogDir(
  kind: 'traces',
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): string | null {
  const slug = activeStance(env, rootDir);
  if (!slug) return null;
  return assertSafeRepositoryPath(path.join(rootDir, STANCE_LOGS_DIR, slug, kind), {
    allowMissingLeaf: true,
    rootDir,
  });
}

/**
 * Resolve a config path with stance overlay precedence:
 * knowledge/personal/stances/{slug}/{subPath} → knowledge/personal/{subPath}.
 * Returns the first existing path; if neither exists, returns the stance path
 * (when a stance is active) or the personal path, so callers can use it for writes.
 */
export function resolveOverlay(subPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const stancePath = stanceRoot(subPath, env);
  if (stancePath && rawExistsSync(stancePath)) return stancePath;
  const personalPath = pathResolver.knowledge(path.join('personal', subPath));
  if (rawExistsSync(personalPath)) return personalPath;
  return stancePath ?? personalPath;
}

/** Both candidate paths (stance overlay + personal base) for callers that merge them. */
export function overlayCandidates(
  subPath: string,
  env: NodeJS.ProcessEnv = process.env
): { overlay: string | null; base: string } {
  return {
    overlay: stanceRoot(subPath, env),
    base: pathResolver.knowledge(path.join('personal', subPath)),
  };
}

/** True when a stance is active and its directory exists. */
export function stanceIsConfigured(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = pathResolver.rootDir()
): boolean {
  const root = stanceRoot('', env, rootDir);
  return root != null && rawExistsSync(root);
}

export const __test__ = {
  SLUG_PATTERN,
  resetLegacyEnvWarning: __stanceEnvTest__.resetLegacyEnvWarning,
};
