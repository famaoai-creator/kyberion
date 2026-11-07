import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@agent/core/logger';
import { frontDeskText, resolveConciergeLocale } from './i18n';
import type { ConciergeProgressScope } from './progress-server';
import { resolveConciergeSelectedViewer } from './selected-tenant';
import { PERSONAL_SELECTION, SYSTEM_SELECTION } from './tenant-context';
import { conciergeErrorBody, narrowConciergeScope } from './viewer-context';

export const PROGRESS_NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
const logger = createLogger('concierge-progress');

function param(req: NextRequest, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = req.nextUrl.searchParams.get(key)?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * The viewer behind a `/api/progress` request. The header's company
 * selection (URL `tenant` hint, then cookie) is resolved server-side on every
 * request, as on あなた待ち: a company narrows to that company, the system
 * view to company-less records (`includeUntenanted`), and the personal view
 * shows every company the viewer may see. `tenant` / `organizationId` /
 * `projectId` then only narrow (outside the viewer's scope → 403).
 */
export function resolveProgressScope(
  req: NextRequest
): { scope: ConciergeProgressScope; response?: never } | { response: NextResponse } {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return { response: resolved.response };
  // The personal view aggregates every company the viewer may see, as on
  // あなた待ち; any other selection narrows from itself.
  const base = resolved.selection.mode === 'personal' ? resolved.viewer : resolved.context;
  const tenant = param(req, 'tenant', 'tenant_slug');
  const narrowed = narrowConciergeScope(base, {
    tenant: tenant === PERSONAL_SELECTION || tenant === SYSTEM_SELECTION ? null : tenant,
    organizationId: param(req, 'organizationId', 'organization_id'),
    projectId: param(req, 'projectId', 'project_id'),
  });
  return {
    scope: {
      ...narrowed,
      ...(base.includeUntenanted ? { includeUntenanted: true } : {}),
      tierAccess: base.tierAccess,
    },
  };
}

/** The readable, coded answer for an item that is unknown or outside the scope. */
export function progressItemUnavailable(req: NextRequest): NextResponse {
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  return NextResponse.json(
    {
      ok: false,
      error: frontDeskText('progress_item_unavailable', locale),
      error_code: 'progress_item_unavailable',
    },
    { status: 404, headers: PROGRESS_NO_STORE }
  );
}

/**
 * A failed read: the cause is logged with the same correlation id the person
 * receives, then answered with the generic coded 500 (`conciergeErrorBody`).
 */
export function progressReadFailed(route: string, error: unknown): NextResponse {
  const { status, body } = conciergeErrorBody(error, 500);
  logger.error(
    `${route} read failed — ${error instanceof Error ? error.message : String(error)} | next: check the task-session, deliverable-inbox and artifact stores and the process role | evidence: correlation_id=${body.correlation_id}`
  );
  return NextResponse.json(body, { status, headers: PROGRESS_NO_STORE });
}
