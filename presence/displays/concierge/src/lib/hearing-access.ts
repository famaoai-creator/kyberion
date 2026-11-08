/**
 * 頼む › ヒアリング (`/api/hearing/*`, `/api/conversation`): the gate in front
 * of the hearing and conversation routes, moved from presence-studio
 * (`hearing-request-scope.ts`, `requirePresenceStudioLocalAdmin`) in the
 * Kyberion server phase 2. The route steps themselves are shared with Studio
 * (`@agent/core/surface/hearing-session-service`, `-mission-service`,
 * `-ledger-service`); this file only decides who may run them.
 *
 * Studio's exposure is kept, with Concierge's rules for "who":
 *
 *   Studio: any authenticated viewer reads a tenant hearing; a credential-free
 *   loopback session (its localadmin) is "the owner" — it alone reads the
 *   personal (no single tenant) hearing store, reads decision receipts and the
 *   conversation, and makes every write.
 *   Concierge: the viewer is resolved server-side (`resolveConciergeViewer`,
 *   401 for an anonymous remote request); "the owner" is
 *   `resolveConciergeInstallationAccess` — the bound installation owner (any
 *   transport for reads; on an attested loopback peer or with a fresh passkey
 *   step-up for writes), or a credential-free loopback request only while
 *   bootstrap is open or the anonymous-loopback escape hatch is on. The
 *   viewer's credential `source` never decides it, and no loopback viewer is
 *   synthesized here: the owner decision is passed to core as `owner`.
 *
 * Writes are browser requests: every POST must carry an `Origin` (or
 * `Referer`) equal to the Host it was sent to, whatever the credential —
 * a bearer API client without one is refused 403 `hearing_origin_denied`, as is
 * a cross-site page (a credential-free loopback request carries no cookie the
 * shared write guard could check). Refusal codes of this gate: 401/403 from the
 * viewer, `invalid_request` (selection), the installation codes
 * (`installation_owner_required`, `installation_step_up_required`,
 * `authentication_required`, `installation_audit_unavailable`),
 * `hearing_origin_denied`, the write guard's 403/429, and 503
 * `hearing_ledger_unavailable` for decision-ledger hearings.
 *
 * Order (a refused request learns nothing else): viewer → `tenant` /
 * `organizationId` / `projectId` selection, which only narrows (Studio's
 * checks: a repeated or reserved value is refused, more than one tenant must
 * be narrowed to one; `tenant=personal`, Concierge's personal view, narrows
 * to no tenant — the personal store) → owner (owner reads and writes) → for a write, a
 * same-origin request (also for a credential-free loopback request, which a
 * cross-site page could otherwise forge) → the shared Concierge write guard
 * (`requireConciergeMutationAccess`, CSRF and token role; a 429 keeps its
 * `Retry-After`). Every write is audited: a refused one at the owner check,
 * an admitted one after the last refusal (`auditConciergeInstallationWrite`).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { createLogger } from '@agent/core/logger';
import type { InstallationOwnerDecision } from '@agent/core/surface/installation-owner-access';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import { progressRecordInScope } from '@agent/core/surface/front-desk-progress';
import { hearingStorageForScope } from '@agent/core/surface/hearing-storage-access';
import { resolveHearingHandoffScope } from '@agent/core/surface/hearing-scope';
import {
  assertHearingWriteLedgerServed,
  HearingLedgerUnavailableError,
  hearingErrorExtras,
  hearingLedgerErrorStatus,
  hearingMissionErrorStatus,
  hearingSessionErrorStatus,
  type HearingAuditFields,
  type HearingQuery,
  type HearingRouteContext,
  type HearingRouteResult,
} from '@agent/core/surface/hearing-session-service';
import type { SurfaceViewerScope } from '@agent/core/surface/surface-viewer-scope-contract';
import { requireConciergeMutationAccess } from './api-guard';
import {
  auditConciergeInstallationWrite,
  installationAccessDenied,
  installationAuditUnavailable,
  resolveConciergeInstallationAccess,
} from './installation-access';
import { PERSONAL_SELECTION } from './tenant-context';
import {
  ConciergeViewerError,
  conciergeErrorBody,
  narrowConciergeScope,
  resolveConciergeViewer,
  type ConciergeViewerContext,
} from './viewer-context';

const logger = createLogger('concierge-hearing');

/** Studio's `express.json({ limit: '1mb' })`. */
const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * `read`: any viewer (a tenant hearing, the agenda, the vocabulary); the
 * owner decision only opens the personal store. `owner-read`: the owner only
 * (decision receipts, the conversation). `write`: the owner only, same origin,
 * then the shared write guard.
 */
export type HearingAccessMode = 'read' | 'owner-read' | 'write';

export interface HearingAccess {
  /** The server-resolved viewer, narrowed by the request's selection. */
  viewer: ConciergeViewerContext;
  /** The core view of the same viewer. */
  scope: SurfaceViewerScope;
  /** `resolveConciergeInstallationAccess` for this request's mode. */
  owner: boolean;
  /** `tenant=personal`: the owner's personal hearing store (the `all` namespace). */
  personal: boolean;
  /** The admitted write grant, when its audit was deferred (`auditAdmitted: false`). */
  writeGrant?: InstallationOwnerDecision;
  response?: never;
}

/** A coded refusal of this gate (`{ ok: false, error, error_code }`). */
function refusal(status: number, code: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: code, error_code: code },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Express-style query object: a repeated key is an array, so strict readers refuse it. */
export function hearingQuery(req: NextRequest): HearingQuery {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of req.nextUrl.searchParams) {
    const current = query[key];
    query[key] =
      current === undefined
        ? value
        : Array.isArray(current)
          ? [...current, value]
          : [current, value];
  }
  return query;
}

/** Studio `resolveHearingRequestViewer`: selection narrows; malformed values are never absence. */
function narrowHearingViewer(
  viewer: ConciergeViewerContext,
  query: HearingQuery
): { viewer: ConciergeViewerContext; personal: boolean } {
  const selection = (key: 'tenant' | 'organizationId' | 'projectId'): string | undefined => {
    const value = query[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string')
      throw new ConciergeViewerError(403, 'Invalid hearing scope selection.');
    const selected = value.trim();
    if (key === 'tenant' && (selected === 'all' || selected === 'unscoped'))
      throw new ConciergeViewerError(403, 'Invalid hearing scope selection.');
    return selected || undefined;
  };
  const tenant = selection('tenant');
  const organizationId = selection('organizationId');
  const projectId = selection('projectId');
  // Concierge's personal view (the selection value the work-inventory
  // hand-off links to): no tenant at all, which only ever narrows. It
  // reaches the personal hearing store, which only the owner may open.
  const personal = tenant === PERSONAL_SELECTION;
  const narrowed: ConciergeViewerContext = {
    ...viewer,
    ...narrowConciergeScope(viewer, {
      tenant: personal ? undefined : tenant,
      organizationId,
      projectId,
    }),
    ...(personal ? { tenantSlugs: [] } : {}),
  };
  if (narrowed.tenantSlugs !== 'all' && narrowed.tenantSlugs.length > 1)
    throw new ConciergeViewerError(403, 'Select one tenant for the hearing.');
  return { viewer: narrowed, personal };
}

/** The core viewer scope of a Concierge viewer (server-resolved fields only). */
export function hearingViewerScope(viewer: ConciergeViewerContext): SurfaceViewerScope {
  return {
    role: viewer.role,
    tenantSlugs: viewer.tenantSlugs,
    organizationIds: viewer.organizationIds,
    projectIds: viewer.projectIds,
    tierAccess: viewer.tierAccess,
    source: viewer.source,
    ...(viewer.principalId ? { principalId: viewer.principalId } : {}),
    ...(viewer.registrationLabel ? { registrationLabel: viewer.registrationLabel } : {}),
    ...(viewer.memberId ? { memberId: viewer.memberId } : {}),
  };
}

/**
 * Admit one hearing / conversation request. `operation` names the write in
 * the installation audit record; `narrow: false` leaves the selection to the
 * route (the conversation narrows from its own query or body).
 */
export function resolveHearingAccess(
  req: NextRequest,
  mode: HearingAccessMode,
  operation: string,
  options: { narrow?: boolean; auditAdmitted?: boolean } = {}
): HearingAccess | { response: Response } {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return { response: resolved.response };
  let viewer: ConciergeViewerContext = resolved.context;
  let personal = false;
  // The conversation narrows by itself (query on GET, body on POST), as on Studio.
  if (options.narrow !== false) {
    try {
      ({ viewer, personal } = narrowHearingViewer(resolved.context, hearingQuery(req)));
    } catch (error) {
      return { response: hearingErrorResponse(req, 'hearing.reject', error, 403) };
    }
  }
  let owner: boolean;
  let writeGrant: InstallationOwnerDecision | undefined;
  if (mode === 'write') {
    const decision = resolveConciergeInstallationAccess(viewer, 'write', req);
    writeGrant = decision;
    if (!decision.allowed) {
      // A refused write is audited too (as `requireConciergeInstallationAccess` does).
      auditConciergeInstallationWrite(decision, operation);
      return { response: installationAccessDenied(decision) };
    }
    owner = true;
    if (
      !isSameOriginMutation({
        method: 'POST',
        headers: req.headers,
        expectedHost: req.headers.get('host') ?? new URL(req.url).host,
      }) ||
      !(req.headers.get('origin') || req.headers.get('referer'))
    )
      return { response: refusal(403, 'hearing_origin_denied') };
    // The shared Concierge write guard, after this route's own refusals.
    const guarded = requireConciergeMutationAccess(req);
    if (guarded) return { response: guarded };
    // Audited once admitted; a write whose audit record cannot be written is refused.
    // A route that then does nothing (`auditAdmitted: false`) records no admitted write.
    if (options.auditAdmitted !== false && !auditConciergeInstallationWrite(decision, operation))
      return { response: installationAuditUnavailable() };
  } else {
    const decision = resolveConciergeInstallationAccess(viewer, 'read', req);
    if (mode === 'owner-read' && !decision.allowed)
      return { response: installationAccessDenied(decision) };
    owner = decision.allowed;
  }
  return {
    viewer,
    scope: hearingViewerScope(viewer),
    owner,
    personal,
    ...(mode === 'write' && options.auditAdmitted === false ? { writeGrant } : {}),
  };
}

/** The shared hearing context for an admitted request. */
export function conciergeHearingContext(
  req: NextRequest,
  access: HearingAccess
): HearingRouteContext {
  const { scope, owner, personal } = access;
  // The personal view opens the `all` store; the steps key receipts and
  // hand-off snapshots by the viewer's namespace, so they see it as `all` too
  // (the same keys as a viewer without a single tenant). In every step `[]`
  // and `all` take the same owner-only personal branch; record visibility
  // (`recordInScope`) and the hand-off destination stay on the narrowed scope.
  const stepViewer: SurfaceViewerScope = personal ? { ...scope, tenantSlugs: 'all' } : scope;
  return {
    viewer: stepViewer,
    owner,
    currentSurface: 'concierge',
    // One personal store on Concierge: `tenant=personal` opens the same `all`
    // namespace as a viewer without a single tenant (and as Studio's loopback
    // owner), so existing personal hearings stay visible. The core facade opens
    // it to the owner only; the viewer scope itself stays narrowed to no tenant.
    storage: () =>
      hearingStorageForScope(stepViewer, {
        owner,
        denied: (message) => new ConciergeViewerError(403, message),
      }),
    handoffScope: (kind) => resolveHearingHandoffScope(scope, kind, { owner }),
    denied: (status, message) => new ConciergeViewerError(status, message),
    audit: (level, action, fields) => logger[level](hearingAuditLine(req, action, fields)),
    recordInScope: (record) => progressRecordInScope(scope, record),
    // The personal view is a selection, not a viewer tenant: carry it on every
    // URL a step returns so the follow-up request opens the same store.
    ...(personal ? { selectionUrl: withPersonalSelection } : {}),
  };
}

/** `tenant=personal` on a returned URL (relative URLs stay relative). */
function withPersonalSelection(path: string): string {
  const base = 'http://hearing.invalid';
  const url = new URL(path, base);
  url.searchParams.set('tenant', PERSONAL_SELECTION);
  return url.origin === base ? url.pathname + url.search + url.hash : url.href;
}

/** One audit line: the action, the request, the viewer-free fields the step reported. */
export function hearingAuditLine(
  req: NextRequest,
  action: string,
  fields: HearingAuditFields
): string {
  const parts = [
    `[concierge][${action}]`,
    `method=${String(req.method || 'UNKNOWN').toUpperCase()}`,
    `path=${req.nextUrl.pathname}`,
  ];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
}

/** Status of Concierge's own viewer refusal, if `error` is one. */
export function conciergeViewerErrorStatus(error: unknown): number | undefined {
  return error instanceof ConciergeViewerError ? error.status : undefined;
}

/**
 * A refused hearing request: Studio's body (the wire error plus the typed
 * hearing detail) under this surface's error format, audited at warn.
 */
export function hearingErrorResponse(
  req: NextRequest,
  action: string,
  error: unknown,
  status: number,
  extras: boolean = true
): NextResponse {
  logger.warn(
    hearingAuditLine(req, action, {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  const { body } = conciergeErrorBody(error, status);
  return NextResponse.json({ ...body, ...(extras ? hearingErrorExtras(error) : {}) }, { status });
}

/** One shared hearing result as a Next response. */
export async function hearingResponse(
  result: HearingRouteResult | Promise<HearingRouteResult>
): Promise<Response> {
  const value = await result;
  if (value.kind === 'html') {
    return new NextResponse(value.html, {
      status: value.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...value.headers },
    });
  }
  const response = NextResponse.json(value.body, {
    status: value.status,
    ...(value.headers ? { headers: value.headers } : {}),
  });
  value.after?.();
  return response;
}

/**
 * The JSON body: `undefined` when there is none (Studio's parser left an
 * empty request without a body); `invalid` for unparsable or oversized input,
 * which Studio's body parser refused before the route ran.
 */
export async function readHearingBody(
  req: NextRequest
): Promise<{ body: unknown; invalid?: never } | { invalid: true; body?: never }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { invalid: true };
  }
  if (!text) return { body: undefined };
  if (Buffer.byteLength(text, 'utf8') > BODY_LIMIT_BYTES) return { invalid: true };
  try {
    return { body: parseSafeJsonInput(text, 'hearing request body') };
  } catch {
    return { invalid: true };
  }
}

/** Studio's body-parser refusal of an unparsable body, under this surface's error format. */
export function invalidHearingBody(req: NextRequest, action: string): NextResponse {
  return hearingErrorResponse(req, action, new Error('Invalid JSON request body.'), 400, false);
}

/** Which shared step family a route belongs to (each maps its refusals its own way). */
export type HearingRouteFamily = 'session' | 'mission' | 'ledger';

const REJECT_ACTION: Record<HearingRouteFamily, string> = {
  session: 'hearing.reject',
  mission: 'hearing.handoff.reject',
  ledger: 'hearing.ledger.reject',
};

function familyStatus(family: HearingRouteFamily, error: unknown): number {
  if (family === 'mission') return hearingMissionErrorStatus(error, conciergeViewerErrorStatus);
  if (family === 'ledger') return hearingLedgerErrorStatus(error, conciergeViewerErrorStatus);
  return hearingSessionErrorStatus(error, conciergeViewerErrorStatus);
}

/**
 * Run one hearing route: the gate, then (for a write) the JSON body, then the
 * shared step; a thrown refusal is answered with the family's status.
 */
export async function runHearingRoute(
  req: NextRequest,
  options: {
    mode: HearingAccessMode;
    operation: string;
    family: HearingRouteFamily;
    /** The route's session id (writes: refused ledger hearings are not audited as admitted). */
    session?: string;
  },
  step: (
    ctx: HearingRouteContext,
    input: { query: HearingQuery; body: unknown }
  ) => HearingRouteResult | Promise<HearingRouteResult>
): Promise<Response> {
  const write = options.mode === 'write';
  const access = resolveHearingAccess(req, options.mode, options.operation, {
    auditAdmitted: !write,
  });
  if (access.response) return access.response;
  const action = REJECT_ACTION[options.family];
  const ctx = conciergeHearingContext(req, access);
  const ledgerRefusal = (error: HearingLedgerUnavailableError) => {
    logger.warn(
      hearingAuditLine(req, 'hearing.ledger.reject', { status: 503, error: error.message })
    );
    return refusal(503, error.code);
  };
  let body: unknown;
  if (write) {
    const read = await readHearingBody(req);
    if (read.invalid) return invalidHearingBody(req, action);
    body = read.body;
    // A write that would end in the decision-ledger refusal does nothing, so it
    // is refused before it is recorded as an admitted installation write.
    try {
      assertHearingWriteLedgerServed(ctx, options.session, body);
    } catch (error) {
      if (error instanceof HearingLedgerUnavailableError) return ledgerRefusal(error);
      // Any other refusal is the step's own; it raises it again below.
    }
    // Audited once admitted, before any effect; an unwritable audit refuses the write.
    if (access.writeGrant && !auditConciergeInstallationWrite(access.writeGrant, options.operation))
      return installationAuditUnavailable();
  }
  try {
    return await hearingResponse(step(ctx, { query: hearingQuery(req), body }));
  } catch (error) {
    if (error instanceof HearingLedgerUnavailableError) return ledgerRefusal(error);
    return hearingErrorResponse(
      req,
      action,
      error,
      familyStatus(options.family, error),
      options.family !== 'ledger'
    );
  }
}

/**
 * The decision-ledger steps are not served here: the concierge role may not
 * assume `decision_ledger` (CD-12, role-assumption-policy.json), so neither the
 * agenda read nor the `decisions import` facade child runs. Answered after the
 * gate, so a refused viewer still learns nothing else.
 */
export async function hearingLedgerUnavailable(
  req: NextRequest,
  mode: HearingAccessMode,
  operation: string
): Promise<Response> {
  // Nothing happens after the gate, so no admitted installation write is audited.
  const access = resolveHearingAccess(req, mode, operation, { auditAdmitted: false });
  if (access.response) return access.response;
  logger.warn(
    hearingAuditLine(req, 'hearing.ledger.reject', {
      status: 503,
      error: 'decision ledger not available on this surface',
    })
  );
  return refusal(503, 'hearing_ledger_unavailable');
}
