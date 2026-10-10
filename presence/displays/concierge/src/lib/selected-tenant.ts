import type { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { createLogger } from '@agent/core/logger';
import { listTenantProfileSlugs } from '@agent/core/organization/tenant-registry';
import { parseCookieHeader } from '@agent/core/surface/surface-session-cookie';
import {
  ConciergeViewerError,
  conciergeErrorResponse,
  resolveConciergeViewer,
  type ConciergeViewerContext,
} from './viewer-context';
import {
  PERSONAL_SELECTION,
  SELECTED_TENANT_COOKIE,
  SELECTED_TENANT_PARAM,
  SYSTEM_SELECTION,
} from './tenant-context';

const logger = createLogger('concierge-tenant-selection');

/** Every request re-reads the registry, so an outage is reported once per interval. */
const REGISTRY_WARNING_INTERVAL_MS = 60_000;
let lastRegistryWarningAt: number | null = null;

/**
 * The company a request is narrowed to, the personal aggregate, or the
 * company-less (system) items. Resolved server-side on every request from
 * untrusted hints (URL, then cookie).
 */
export type SelectedTenantScope =
  | { mode: 'tenant'; tenant_slug: string; source: 'url' | 'cookie' | 'only_tenant' }
  | { mode: 'personal'; source: 'url' | 'cookie' | 'default' }
  | { mode: 'system'; source: 'url' | 'cookie' | 'default' };

export interface TenantSelectionOptions {
  /** The viewer's scope is every company (`tenantSlugs: 'all'`). */
  allCompanies: boolean;
}

export interface TenantSelectionHints {
  url?: string | null;
  cookie?: string | null;
}

export interface TenantSelectionResult {
  selection: SelectedTenantScope;
  /** Hints that were present but refused (not allowed, malformed, or a reserved name). */
  rejected: Array<'url' | 'cookie'>;
}

/**
 * Pure. The URL hint beats the cookie hint; a hint is honoured only when it is
 * `personal`, `shared` (system — all-company viewers only) or a valid,
 * non-reserved slug inside `allowedTenants`. A refused URL hint falls back to
 * the default (never to the cookie). A viewer scoped to exactly one company
 * always sees that company; an all-company viewer is never pinned to one.
 */
export function resolveSelectedTenantScope(
  hints: TenantSelectionHints,
  allowedTenants: readonly string[],
  options: TenantSelectionOptions
): TenantSelectionResult {
  const allowed = new Set(allowedTenants.filter((slug) => isValidTenantSlug(slug)));
  const rejected: Array<'url' | 'cookie'> = [];
  const only = !options.allCompanies && allowed.size === 1 ? [...allowed][0] : null;
  for (const source of ['url', 'cookie'] as const) {
    const value = hints[source]?.trim();
    if (!value) continue;
    if (value === PERSONAL_SELECTION) {
      if (only) break;
      return { selection: { mode: 'personal', source }, rejected };
    }
    if (value === SYSTEM_SELECTION && options.allCompanies) {
      return { selection: { mode: 'system', source }, rejected };
    }
    if (isValidTenantSlug(value) && allowed.has(value)) {
      return { selection: { mode: 'tenant', tenant_slug: value, source }, rejected };
    }
    rejected.push(source);
    if (source === 'url') break;
  }
  if (only)
    return { selection: { mode: 'tenant', tenant_slug: only, source: 'only_tenant' }, rejected };
  if (options.allCompanies && allowed.size === 0)
    return { selection: { mode: 'system', source: 'default' }, rejected };
  return { selection: { mode: 'personal', source: 'default' }, rejected };
}

export function readTenantSelectionHints(
  req: Pick<NextRequest, 'headers' | 'nextUrl'>
): TenantSelectionHints {
  return {
    url: req.nextUrl?.searchParams.get(SELECTED_TENANT_PARAM) ?? null,
    cookie: parseCookieHeader(req.headers?.get('cookie'))[SELECTED_TENANT_COOKIE] ?? null,
  };
}

/**
 * The companies the viewer may select: its explicit tenant scope, or — for an
 * all-tenant viewer — the tenant registry. Reserved and malformed names never
 * count as tenants. An unreadable registry yields no companies (fail closed).
 */
export function conciergeAllowedTenants(
  viewer: Pick<ConciergeViewerContext, 'tenantSlugs'>
): string[] {
  let listed: readonly string[];
  if (viewer.tenantSlugs !== 'all') {
    listed = viewer.tenantSlugs;
  } else {
    try {
      listed = withExecutionContext('sovereign_concierge', () => listTenantProfileSlugs());
    } catch (error) {
      const now = Date.now();
      if (
        lastRegistryWarningAt === null ||
        now < lastRegistryWarningAt ||
        now - lastRegistryWarningAt >= REGISTRY_WARNING_INTERVAL_MS
      ) {
        lastRegistryWarningAt = now;
        logger.warn(
          `tenant registry unreadable — the switcher offers no companies and shows no company data | next: check the tenant registry (knowledge/confidential/*/tenant-profile) | evidence: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      listed = [];
    }
  }
  return [...new Set(listed.filter((slug) => isValidTenantSlug(slug)))].sort();
}

/**
 * Narrows (never widens) the viewer to the selection. A company narrows to
 * that one tenant; the personal view hides every company's detail; the system
 * view (all-company viewers only) shows only items that carry no tenant.
 */
export function applyTenantSelection(
  fullViewer: ConciergeViewerContext,
  selection: SelectedTenantScope,
  allowedTenants: readonly string[]
): ConciergeViewerContext {
  const viewer: ConciergeViewerContext = { ...fullViewer };
  delete viewer.includeUntenanted;
  if (selection.mode === 'system') {
    if (viewer.tenantSlugs !== 'all') {
      throw new ConciergeViewerError(403, 'system selection requires an all-company viewer');
    }
    return { ...viewer, tenantSlugs: [], includeUntenanted: true };
  }
  if (selection.mode === 'tenant') {
    const slug = selection.tenant_slug;
    if (
      !isValidTenantSlug(slug) ||
      !allowedTenants.includes(slug) ||
      (viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(slug))
    ) {
      throw new ConciergeViewerError(403, 'selected tenant is outside the viewer scope');
    }
    return { ...viewer, tenantSlugs: [slug] };
  }
  return { ...viewer, tenantSlugs: [] };
}

/**
 * Entries of the selected company only, with their memberships cut to that
 * scope too. The system view lists the entries that belong to no company.
 */
export function scopeMembershipList<
  T extends { memberships: ReadonlyArray<{ tenant_slug: string }> },
>(
  entries: readonly T[],
  scope: Pick<ConciergeViewerContext, 'tenantSlugs' | 'includeUntenanted'>
): T[] {
  const { tenantSlugs } = scope;
  if (tenantSlugs === 'all') return [...entries];
  if (scope.includeUntenanted && tenantSlugs.length === 0) {
    return entries.filter((entry) => entry.memberships.length === 0);
  }
  return entries
    .map((entry) => ({
      ...entry,
      memberships: entry.memberships.filter((membership) =>
        tenantSlugs.includes(membership.tenant_slug)
      ),
    }))
    .filter((entry) => entry.memberships.length > 0);
}

export interface ConciergeSelectedViewer {
  /** The viewer narrowed to the selection — what a read route may show. */
  context: ConciergeViewerContext;
  /** The viewer's full authorized scope (for the switcher and the personal aggregate). */
  viewer: ConciergeViewerContext;
  selection: SelectedTenantScope;
  allowedTenants: string[];
  response?: never;
}

/**
 * Resolves the viewer, then the selected company, on every request. Cookie
 * and URL are hints; the result is always within the viewer's allowed set.
 */
export function resolveConciergeSelectedViewer(
  req: NextRequest
): ConciergeSelectedViewer | { response: NextResponse } {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return { response: resolved.response };
  const viewer = resolved.context;
  const allowedTenants = conciergeAllowedTenants(viewer);
  const { selection, rejected } = resolveSelectedTenantScope(
    readTenantSelectionHints(req),
    allowedTenants,
    { allCompanies: viewer.tenantSlugs === 'all' }
  );
  if (rejected.length > 0) {
    logger.debug(
      `tenant selection refused — not in the viewer's allowed set | next: shown as the ${
        selection.mode === 'tenant' ? 'only company' : `${selection.mode} view`
      } | evidence: ${rejected.join(',')} principal=${viewer.principalId ?? 'anonymous'}`
    );
  }
  let context: ConciergeViewerContext;
  try {
    context = applyTenantSelection(viewer, selection, allowedTenants);
  } catch (error) {
    if (error instanceof ConciergeViewerError) return { response: conciergeErrorResponse(error) };
    throw error;
  }
  return { viewer, context, selection, allowedTenants };
}

/**
 * A conversation follows a selected company; the personal and system views
 * keep the viewer's own conversation scope instead of hiding everything.
 */
export function conversationViewerForSelection(
  req: NextRequest
):
  | { context: ConciergeViewerContext; response?: never }
  | { context?: never; response: NextResponse } {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return { response: resolved.response };
  return {
    context: resolved.selection.mode === 'tenant' ? resolved.context : resolved.viewer,
  };
}
