/**
 * What a surface hands the shared hearing operations for one request
 * (`hearing-session-service.ts`, `hearing-ledger-service.ts`,
 * `hearing-mission-service.ts`), and the request-free input readers they share.
 * Used by: Studio and Concierge hearing routes.
 */
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
import { normalizeLocale, type SupportedLocale } from '../foundation/locale-normalize.js';
import { readSurfaceStringParam } from './surface-request-input.js';
import type { FrontDeskSurfaceId } from './front-desk-nav.js';
import type { HearingStorage } from './hearing-storage-access.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';
import type { HearingRecord, HearingScenario } from './hearing.js';
import { withExecutionContext } from '../authority.js';
import { resolveMemberByPrincipal } from '../organization/member-registry.js';
import { parseDecisionsScenarioId } from '../decision-ledger/index.js';

/** A 400 refusal of a decision-ledger hearing request. */
export class HearingLedgerRequestError extends Error {
  readonly status = 400 as const;
}

/**
 * A decision-ledger hearing on a surface that may not read the ledger (no
 * {@link HearingLedgerReader}): refused before any record is changed, any
 * template canvas is drawn or any model sees the tenant's decision labels
 * (SD-05). Surfaces answer it as 503 `hearing_ledger_unavailable`.
 */
export class HearingLedgerUnavailableError extends Error {
  readonly status = 503 as const;
  readonly code = 'hearing_ledger_unavailable' as const;
  constructor() {
    super('Decision-ledger hearings are not served here.');
  }
}

/** Refuse a stored or requested decision-ledger scenario when the surface has no ledger reader. */
export function assertHearingLedgerServed(
  ledger: HearingLedgerReader | undefined,
  scenario: string | undefined
): void {
  if (!ledger && typeof scenario === 'string' && parseDecisionsScenarioId(scenario) !== undefined)
    throw new HearingLedgerUnavailableError();
}

/**
 * The tenant decision-ledger reads a hearing step needs (`hearing-ledger-service.ts`),
 * supplied by a surface whose process may read the ledger (`decision_ledger`).
 * Absent, decision-ledger hearings are refused and no ledger is read.
 */
export interface HearingLedgerReader {
  /** `decisions-<case>-<actor>` → the scenario of that case's open decisions (else undefined). */
  scenarioRef: (namespace: string, ref: string) => HearingScenario | undefined;
  /** The ledger projection canvas of a ledger hearing (else undefined). */
  canvas: (namespace: string, record: HearingRecord, locale: SupportedLocale) => string | undefined;
}

/** The member the viewer is, resolved server-side (never from the request). */
export function resolveHearingMember(viewer: SurfaceViewerScope) {
  return withExecutionContext('ecosystem_architect', () =>
    resolveMemberByPrincipal({
      principalId: viewer.principalId,
      source: viewer.source,
      registrationLabel: viewer.registrationLabel,
      memberId: viewer.memberId,
    })
  );
}

/** Values an audit line carries (the adapter renders the line in its own format). */
export type HearingAuditFields = Record<string, string | number | boolean | null | undefined>;

/** Destination metadata `resolveHearingHandoffScope` returns. */
export interface HearingHandoffDestination {
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
}

/**
 * What a surface hands the hearing operations for one request. Every field is
 * server-derived by the adapter; nothing comes from the request body.
 */
export interface HearingRouteContext {
  /** The server-resolved, already narrowed viewer (one tenant at most). */
  viewer: SurfaceViewerScope;
  /** The surface's own owner decision for this request (`HearingOwnerInput`). */
  owner: boolean;
  /** The surface rendering the hearing; front-desk links hosted there stay relative. */
  currentSurface: FrontDeskSurfaceId;
  /** Hearing storage bound to this viewer and owner; called where the route needs it. */
  storage: () => HearingStorage;
  /** `resolveHearingHandoffScope` bound to this viewer and owner. */
  handoffScope: (kind: 'mission' | 'inventory') => HearingHandoffDestination;
  /** The surface's own refusal for a member that may not act (403). */
  denied: (status: 403, message: string) => Error;
  /** Audit sink: the adapter adds its request facts (method, path, client). */
  audit: (level: 'info' | 'warn', action: string, fields: HearingAuditFields) => void;
  /** Whether a record (a created mission) is inside the viewer's scope. */
  recordInScope: (record: unknown) => boolean;
  /** The decision-ledger reads, when this surface may read the ledger (see {@link HearingLedgerReader}). */
  ledger?: HearingLedgerReader;
  /**
   * The surface's own selection carried on the URLs a step returns (the canvas
   * URL, the inventory hand-off link), when the viewer scope alone cannot say
   * it (Concierge's personal view). Absent: `hearingScopedUrl` only.
   */
  selectionUrl?: (url: string) => string;
}

/** The answer an operation produces; the adapter writes it to its framework's response. */
export type HearingRouteResult =
  | {
      kind: 'json';
      status: number;
      body: unknown;
      headers?: Record<string, string>;
      /** Work to start only after the response was sent. */
      after?: () => void;
    }
  | { kind: 'html'; status: 200; html: string; headers: Record<string, string> };

export type HearingQuery = Record<string, unknown>;

/** A JSON body as Studio's `safeParsePresenceStudioRequestBody`: absent stays
 * `undefined`, an unsafe or malformed object becomes `null`. */
export function parseHearingRequestBody(body: unknown, label: string): unknown {
  if (body === undefined) return undefined;
  try {
    return parseSafeJsonObjectValue(body, label);
  } catch {
    return null;
  }
}

/** The request locale (`?locale=`), English when absent or unsupported. */
export function hearingQueryLocale(query: HearingQuery): SupportedLocale {
  return normalizeLocale(readSurfaceStringParam(query.locale)) ?? 'en';
}
