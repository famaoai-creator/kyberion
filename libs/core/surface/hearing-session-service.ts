/**
 * The hearing session operations (HT-01/03/04, WI-08, SD-02/05), framework
 * neutral so every surface that serves `/api/hearing/:session/*` runs the
 * same steps in the same order (Studio's express routes and Concierge's Next
 * routes). A surface adapter resolves its viewer and authority first, then
 * hands this module a {@link HearingRouteContext}: the server-resolved,
 * already narrowed viewer, its own owner decision, its own refusal error and
 * audit sink, and the storage / destination seams bound to that viewer.
 *
 * Nothing here reads a request: `sessionId`, `query` and `body` are the raw
 * values the adapter took from the request, validated here exactly as the
 * Studio routes validated them. Errors are thrown; the adapter maps them with
 * {@link hearingSessionErrorStatus} / {@link hearingErrorExtras}.
 */
import { randomUUID } from 'node:crypto';
import { nowIso } from '../foundation/time.js';
import { t as catalogT, type VocabularyKey } from '../localization/t.js';
import { normalizeLocale, type SupportedLocale } from '../foundation/locale-normalize.js';
import { readSurfaceStringParam } from './surface-request-input.js';
import { withExecutionContext } from '../authority.js';
import { logger } from '../core.js';
import { humanActor } from '../contracts/actor.js';
import { frontDeskRoleFromViewerScope, type FrontDeskRole } from './front-desk-identity.js';
import {
  resolveFrontDeskDestination,
  readFrontDeskSurfaceUrls,
  type FrontDeskSurfaceId,
} from './front-desk-nav.js';
import type { IntentResolutionContract } from '../intent/intent-resolution-contract-parser.js';
import {
  defaultHearingScenario,
  findHearingScenario,
  hearingPhaseProgress,
} from './hearing-scenario-catalog.js';
import { proposeWorkDecomposition } from '../workforce/work-inventory-decompose.js';
import {
  saveWorkInventoryEntry,
  WorkInventoryStoreError,
  type WorkInventoryScope,
} from '../workforce/work-inventory.js';
import {
  applyHearingTurn,
  createHearingRecord,
  hearingScenarioFromCatalogEntry,
  nextHearingQuestion,
  validateHearingScenario,
  type HearingDecidedBy,
  type HearingRecord,
  type HearingDecisionIdentity,
  type HearingScenario,
} from './hearing.js';
import {
  defaultHearingRecord,
  renderHearingCanvas,
  assertHearingEditable,
  assertHearingHandoffReplay,
  HearingConflictError,
  HearingOperationError,
  parseHearingDecisionOperation,
  hearingDecisionReceipt,
} from './hearing-runtime.js';
import { hearingDecisionScopeKey, type HearingStorage } from './hearing-storage-access.js';
import { generateHearingCanvas } from './hearing-canvas.js';
import {
  buildWorkInventoryDecompositionInput,
  renderWorkInventoryCanvasHtml,
} from './hearing-work-inventory.js';
import {
  hearingWorkInventoryHandoffHref,
  hearingWorkInventoryScope,
  readHearingCompletion,
  type HearingCompletionOptions,
  type HearingWorkInventoryHandoffFields,
} from './hearing-completion.js';
import { hearingScopedUrl, HearingScopeError } from './hearing-scope.js';
import {
  assertHearingHandoffSnapshot,
  withHearingHandoffSnapshot,
} from './hearing-handoff-snapshot.js';
import { parseDecisionsScenarioId } from '../decision-ledger/index.js';
import type { SurfaceViewerScope } from './surface-viewer-scope-contract.js';
import {
  assertHearingLedgerServed,
  HearingLedgerRequestError,
  HearingLedgerUnavailableError,
  hearingQueryLocale,
  parseHearingRequestBody,
  resolveHearingMember,
  type HearingLedgerReader,
  type HearingQuery,
  type HearingRouteContext,
  type HearingRouteResult,
} from './hearing-route-context.js';

export type {
  HearingAuditFields,
  HearingHandoffDestination,
  HearingQuery,
  HearingRouteContext,
  HearingRouteResult,
} from './hearing-route-context.js';
export {
  assertHearingLedgerServed,
  HearingLedgerRequestError,
  HearingLedgerUnavailableError,
  hearingQueryLocale,
  parseHearingRequestBody,
  resolveHearingMember,
} from './hearing-route-context.js';
export type { HearingLedgerReader } from './hearing-route-context.js';
// One public subpath for the shared hearing steps: the mission hand-off and the
// decision-ledger seam live in their own modules.
export {
  handOffHearingToMission,
  hearingMissionErrorStatus,
  HearingMissionRequestError,
  type HearingRecordWithMissionHandoff,
} from './hearing-mission-service.js';
export {
  buildLedgerImportLines,
  hearingLedgerErrorStatus,
  readHearingLedgerAgenda,
  recordHearingDecisions,
  renderLedgerCanvasForRecord,
  resolveLedgerScenarioRef,
  type HearingLedgerFields,
  type HearingRecordWithLedger,
} from './hearing-ledger-service.js';

/** A 400 refusal of the request itself (session id, body, scenario, state). */
export class HearingRequestError extends Error {
  readonly status = 400 as const;
}

export type HearingRecordWithInventoryFields = HearingRecord & HearingWorkInventoryHandoffFields;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Completion links and owner for this request. */
export function hearingCompletionOptions(ctx: HearingRouteContext): HearingCompletionOptions {
  return { currentSurface: ctx.currentSurface, owner: ctx.owner };
}

function hearingSessionId(raw: unknown): string {
  const sessionId = String(raw || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(sessionId)) {
    throw new HearingRequestError('Invalid hearing session id.');
  }
  return sessionId;
}

function hearingScenarioFromRecord(
  record: ReturnType<typeof defaultHearingRecord>
): HearingScenario {
  return {
    id: record.scenario,
    requirements: record.requirements.map(({ id, label_key, label_source, label_text }) => ({
      id,
      label_key,
      ...(label_source ? { label_source } : {}),
      ...(label_text ? { label_text } : {}),
    })),
  };
}

/** WI-08: resolves `scenario_id` (POST body / GET query) against
 * `hearing-scenarios.json`; an unknown id is a 400, never a silent
 * default — `undefined` (no `scenario_id` at all) leaves the caller free to
 * fall back to the existing default/`input.scenario` behavior. */
function resolveHearingScenarioParam(scenarioId: unknown): HearingScenario | undefined {
  if (typeof scenarioId !== 'string' || !scenarioId.trim()) return undefined;
  // SD-02: a ledger hearing's id (`decisions-<case>-<actor>`) is not a catalog
  // entry; its record is resolved from the tenant ledger, never from here.
  if (parseDecisionsScenarioId(scenarioId.trim()) !== undefined) return undefined;
  const entry = findHearingScenario(scenarioId.trim());
  if (!entry) {
    throw new HearingRequestError(`Unknown hearing scenario_id: ${scenarioId}`);
  }
  return hearingScenarioFromCatalogEntry(entry);
}

/** A ledger scenario (`decisions-<case>-<actor>`) through the surface's ledger reader;
 * a surface without one refuses it before any ledger is read. */
function ledgerScenarioRef(
  ledger: HearingLedgerReader | undefined,
  namespace: string,
  ref: string
): HearingScenario | undefined {
  if (ledger) return ledger.scenarioRef(namespace, ref);
  assertHearingLedgerServed(ledger, ref);
  return undefined;
}

/** Read routes: a ledger id resolves from the viewer's tenant ledger so the unpersisted default
 * record carries the same `scenario` the client validates accepted records against. */
function resolveReadScenarioParam(
  ledger: HearingLedgerReader | undefined,
  namespace: string,
  scenarioId: unknown
): HearingScenario | undefined {
  const id = typeof scenarioId === 'string' ? scenarioId.trim() : '';
  if (id && parseDecisionsScenarioId(id)) return ledgerScenarioRef(ledger, namespace, id);
  return resolveHearingScenarioParam(scenarioId);
}

/** WI-08: dispatches to the scenario's own canvas renderer — the
 * deterministic `work_inventory_table` (no model call) for scenarios that
 * declare it, the existing deterministic `web_app_preview` template
 * otherwise (unregistered/legacy scenarios keep today's behavior). */
async function renderCurrentHearingCanvas(
  record: HearingRecord,
  locale: SupportedLocale
): Promise<string> {
  const scenarioDef = findHearingScenario(record.scenario);
  return scenarioDef?.canvas === 'work_inventory_table'
    ? renderWorkInventoryCanvasHtml(record, locale)
    : renderHearingCanvas(record, locale);
}

/** WI-08: the `work_inventory` hand-off requires a concrete scope — a
 * platform-wide viewer (`namespace === 'all'`) that is not the owner has no
 * single tenant/personal scope to file the entry under, so it is refused the
 * same way the mission hand-off refuses a hand-off without a concrete tenant. */
function workInventoryScopeForHandoff(ctx: HearingRouteContext): WorkInventoryScope {
  const destination = ctx.handoffScope('inventory');
  const scope = hearingWorkInventoryScope(ctx.viewer, { owner: ctx.owner });
  if (!scope) {
    throw new HearingRequestError(
      'Work inventory hand-off requires a concrete tenant or a local owner session.'
    );
  }
  return {
    ...scope,
    ...(destination.organizationId ? { organization_id: destination.organizationId } : {}),
  };
}

function buildWorkInventoryNextAction(locale: SupportedLocale, ctx: HearingRouteContext) {
  const progressItem = resolveFrontDeskDestination('progress', {
    currentSurface: ctx.currentSurface,
    urls: readFrontDeskSurfaceUrls(),
    role: frontDeskRoleFromViewerScope(ctx.viewer),
  });
  return {
    label_key: 'front_desk:hearing_inventory_open' as const,
    label: catalogT('front_desk:hearing_inventory_open', undefined, locale),
    href: progressItem?.allowed
      ? withSelection(
          ctx,
          hearingWorkInventoryHandoffHref(
            hearingScopedUrl(progressItem.href, ctx.viewer),
            ctx.viewer,
            {
              owner: ctx.owner,
            }
          )
        )
      : '',
  };
}

/** HT-06: the JSON `record` payload resolves each requirement's `label_key`
 * to the request's locale at response time — never persisted — so a locale
 * change re-renders instead of freezing the answering locale. */
export function withResolvedLabels(
  record: ReturnType<typeof defaultHearingRecord>,
  locale: SupportedLocale
) {
  return {
    ...record,
    // SD-02: the client never re-derives the scenario grammar; the server says
    // whether this hearing is a decision-ledger hearing.
    is_ledger: parseDecisionsScenarioId(record.scenario) !== undefined,
    requirements: record.requirements.map((item) => ({
      ...item,
      // SD-02: tenant-owned labels (decision ledger items) are free text and
      // bypass the vocabulary catalog; only `label_source: 'vocabulary'` (or
      // absent) resolves through `label_key`.
      label:
        item.label_source === 'tenant' && item.label_text
          ? item.label_text
          : catalogT(item.label_key as VocabularyKey, undefined, locale),
    })),
  };
}

/** Label of one requirement in the request locale (tenant free text or vocabulary). */
function requirementLabel(
  item: { label_key: string; label_source?: 'vocabulary' | 'tenant'; label_text?: string },
  locale: SupportedLocale
): string {
  return item.label_source === 'tenant' && item.label_text
    ? item.label_text
    : catalogT(item.label_key as VocabularyKey, undefined, locale);
}

/** `scenario_ref` naming a catalog sheet (`web_app_build`, `process_improvement`, …). */
function resolveCatalogScenarioRef(ref: string): HearingScenario | undefined {
  const found = findHearingScenario(ref);
  return found ? hearingScenarioFromCatalogEntry(found) : undefined;
}

/** The catalog's default sheet (phase-structured), as a hearing scenario. */
export function defaultCatalogScenario(): HearingScenario {
  return hearingScenarioFromCatalogEntry(defaultHearingScenario());
}

/** Per-phase progress with resolved titles — the sheet's "where are we". */
export function phasePayload(record: HearingRecord, locale: SupportedLocale) {
  const progress = hearingPhaseProgress(record.requirements, record.phases ?? []);
  const withTitles = progress.phases.map((phase) => ({
    ...phase,
    title: catalogT(phase.title_key as VocabularyKey, undefined, locale),
  }));
  const current = progress.current
    ? (withTitles.find((phase) => phase.id === progress.current?.id) ?? null)
    : null;
  return { phases: record.phases?.length ? withTitles : [], current_phase: current };
}

/** What the companion asks next, or `null` when every requirement is answered. */
export function nextQuestionPayload(record: HearingRecord, locale: SupportedLocale) {
  const next = nextHearingQuestion(record);
  const phases = phasePayload(record, locale);
  if (!next) {
    return {
      next_question: null,
      prompt: catalogT('front_desk:hearing_all_answered', undefined, locale),
      ...phases,
    };
  }
  const label = requirementLabel(next, locale);
  const phase = phases.current_phase;
  return {
    next_question: { id: next.id, label, ...(next.phase_id ? { phase_id: next.phase_id } : {}) },
    prompt: phase
      ? catalogT('front_desk:hearing_next_question_in_phase', { phase: phase.title, label }, locale)
      : catalogT('front_desk:hearing_next_question', { label }, locale),
    ...phases,
  };
}

/** The canvas URL changes whenever a new version exists, so an iframe reloads on change.
 * WI-08: it also carries `?scenario_id=` so the canvas iframe's own, separate
 * request resolves the right default scenario before anything is persisted —
 * the browser loads this URL directly, it never carries whatever query the
 * record fetch used. */
function hearingCanvasUrl(
  sessionId: string,
  record: HearingRecord,
  ctx: HearingRouteContext,
  locale: SupportedLocale
): string {
  const latest = record.canvas_versions[record.canvas_versions.length - 1];
  const base = `/api/hearing/${encodeURIComponent(sessionId)}/canvas`;
  const params = new URLSearchParams();
  params.set('scenario_id', record.scenario);
  if (latest) params.set('version', latest);
  params.set('locale', locale);
  return withSelection(ctx, hearingScopedUrl(`${base}?${params.toString()}`, ctx.viewer));
}

/** The surface's own selection on a returned URL, so a follow-up resolves the same store. */
function withSelection(ctx: HearingRouteContext, url: string): string {
  return ctx.selectionUrl && url ? ctx.selectionUrl(url) : url;
}

/**
 * The status of a refused hearing session request, in Studio's order:
 * conflict 409, the hearing's own 400s, the surface's viewer refusal (its own
 * status), a work-inventory store conflict 409, anything else 500.
 */
export function hearingSessionErrorStatus(
  error: unknown,
  viewerErrorStatus: (error: unknown) => number | undefined
): number {
  if (error instanceof HearingConflictError) return 409;
  if (
    error instanceof HearingRequestError ||
    error instanceof HearingLedgerRequestError ||
    error instanceof HearingLedgerUnavailableError ||
    error instanceof HearingOperationError ||
    error instanceof HearingScopeError
  )
    return error.status;
  const viewer = viewerErrorStatus(error);
  if (viewer !== undefined) return viewer;
  if (error instanceof WorkInventoryStoreError) return 409;
  return 500;
}

/** The typed hearing detail a refusal body carries next to the wire error. */
export function hearingErrorExtras(error: unknown): {
  hearing_conflict?: HearingConflictError['conflict'];
  hearing_scope_error?: HearingScopeError['code'];
} {
  return {
    ...(error instanceof HearingConflictError ? { hearing_conflict: error.conflict } : {}),
    ...(error instanceof HearingScopeError ? { hearing_scope_error: error.code } : {}),
  };
}

/** FD-10 (plan §2.5 principle 4): the deciding member's role comes from
 * their own per-tenant membership for the hearing's namespace tenant. A
 * resolved member holding no membership there is a `viewer` — the viewer-
 * scope fallback would misattribute owner/localadmin authority the member
 * does not hold on that tenant (B4). The 'all'/'unscoped' namespace keeps
 * the pre-FD-10 viewer-scope fallback (`frontDeskRoleFromViewerScope`). */
function resolveHearingDeciderRole(
  member: { memberships: ReadonlyArray<{ tenant_slug: string; role: FrontDeskRole }> },
  namespace: string,
  viewer: SurfaceViewerScope
): FrontDeskRole {
  if (namespace !== 'all' && namespace !== 'unscoped') {
    const membership = member.memberships.find((item) => item.tenant_slug === namespace);
    return membership?.role ?? 'viewer';
  }
  return frontDeskRoleFromViewerScope(viewer);
}

/** HT-02: fire-and-forget model canvas generation, keyed per hearing
 * session so at most one `generateHearingCanvas` call runs at a time for a
 * given session. A newer answer arriving while a generation is already in
 * flight does not start a second overlapping call — it replaces
 * `pending`, and once the in-flight call settles its result is applied
 * (only if nothing newer landed meanwhile, see below) before the queued
 * answer's own generation starts. */
interface HearingCanvasGenerationJob {
  storage: HearingStorage;
  namespace: string;
  record: HearingRecord;
  locale: SupportedLocale;
  tenantSlug: string | undefined;
  surface: FrontDeskSurfaceId;
}

const hearingCanvasInFlight = new Map<string, HearingCanvasGenerationJob | undefined>();

function hearingCanvasJobKey(namespace: string, sessionId: string): string {
  return `${namespace}:${sessionId}`;
}

function tenantSlugForHearingDesign(viewer: SurfaceViewerScope): string | undefined {
  return viewer.tenantSlugs !== 'all' ? viewer.tenantSlugs[0] : undefined;
}

function runHearingCanvasGeneration(key: string, job: HearingCanvasGenerationJob): void {
  generateHearingCanvas(job.record, { locale: job.locale, tenantSlug: job.tenantSlug })
    .then((result) => {
      // Fence requirement inputs under the shared lock; preserve newer decisions/canvas metadata.
      job.storage.commitGeneratedCanvas(job.record, result.html, result.source);
    })
    .catch((error) => {
      logger.warn(
        `[${job.surface}] hearing canvas generation failed for ${job.record.session_id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    })
    .finally(() => {
      const queued = hearingCanvasInFlight.get(key);
      if (queued) {
        hearingCanvasInFlight.set(key, undefined);
        runHearingCanvasGeneration(key, queued);
      } else {
        hearingCanvasInFlight.delete(key);
      }
    });
}

function scheduleHearingCanvasGeneration(job: HearingCanvasGenerationJob): void {
  const key = hearingCanvasJobKey(job.namespace, job.record.session_id);
  if (hearingCanvasInFlight.has(key)) {
    // A generation is already running for this session — queue this newer
    // answer to run once it settles instead of overlapping the backend call.
    hearingCanvasInFlight.set(key, job);
    return;
  }
  hearingCanvasInFlight.set(key, undefined);
  runHearingCanvasGeneration(key, job);
}

function hearingDecisionActor(
  ctx: HearingRouteContext,
  namespace: string
): {
  decidedBy: HearingDecidedBy;
  identity: HearingDecisionIdentity;
} {
  const viewer = ctx.viewer;
  const member = resolveHearingMember(viewer);
  if (!member) {
    throw ctx.denied(403, 'decisions are recorded for registered members only');
  }
  const role = resolveHearingDeciderRole(member, namespace, viewer);
  if (role !== 'owner' && role !== 'approver') {
    // Positive allowlist: only decision-capable membership roles may
    // record a decision (`surface.decision.write` is granted to owner and
    // approver only — front-desk-roles.ts). Operators execute but never
    // decide; viewers observe.
    throw ctx.denied(403, 'this member role cannot record decisions');
  }
  const actor = humanActor(member.member_id, member.display_name);
  const decidedBy: HearingDecidedBy = {
    kind: 'human',
    id: actor.id,
    ...(actor.display_name ? { display_name: actor.display_name } : {}),
    role,
  };

  return {
    decidedBy,
    identity: {
      principal_id: viewer.principalId!,
      member_id: member.member_id,
      source: viewer.source as HearingDecisionIdentity['source'],
      scope_key: hearingDecisionScopeKey(viewer),
    },
  };
}

/**
 * The decision-ledger refusal a write would end in, decided before the write
 * is admitted: the stored record's scenario and any ledger scenario the body
 * brings (`scenario_ref`, an inline `scenario.id`). Lets a surface
 * without ledger reads refuse before recording an admitted write. The steps
 * repeat the check themselves; this only moves the refusal earlier.
 */
export function assertHearingWriteLedgerServed(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  rawBody: unknown
): void {
  if (ctx.ledger) return;
  const sessionId = String(rawSessionId || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u.test(sessionId))
    assertHearingLedgerServed(ctx.ledger, ctx.storage().load(sessionId)?.scenario);
  const body = parseHearingRequestBody(rawBody, 'hearing request');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const input = body as Record<string, unknown>;
  const inline =
    input.scenario && typeof input.scenario === 'object' && !Array.isArray(input.scenario)
      ? (input.scenario as { id?: unknown }).id
      : undefined;
  // `scenario_id` naming a ledger id is ignored by the answer step (it only
  // seeds catalog sheets), so it is not refused here either.
  for (const value of [input.scenario_ref, inline])
    if (typeof value === 'string') assertHearingLedgerServed(ctx.ledger, value.trim());
}

/** HT-01: the deterministic canvas of a hearing (a missing record renders its
 * in-memory default). `GET /api/hearing/:session/canvas`. Synchronous unless the
 * scenario's own renderer has to run (a stored version or ledger projection
 * answers at once). */
export function readHearingCanvas(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  query: HearingQuery
): HearingRouteResult | Promise<HearingRouteResult> {
  const sessionId = hearingSessionId(rawSessionId);
  const storage = ctx.storage();
  const locale = hearingQueryLocale(query);
  // WI-08: before the first answer there is no persisted record yet —
  // `?scenario_id=` (the same id `/ask?mode=hearing&scenario=...` picked)
  // lets the default in-memory record reflect the chosen scenario
  // instead of always defaulting to `web_app_build`.
  const scenarioParam = resolveReadScenarioParam(ctx.ledger, storage.namespace, query.scenario_id);
  const stored = storage.load(sessionId);
  assertHearingLedgerServed(ctx.ledger, stored?.scenario);
  const record = stored || defaultHearingRecord(sessionId, nowIso(), scenarioParam);
  const requestedVersion = typeof query.version === 'string' ? query.version : '';
  const versionedCanvas = requestedVersion ? storage.canvas(sessionId, requestedVersion) : null;
  if (requestedVersion && !versionedCanvas)
    throw new HearingRequestError('Hearing canvas version was not found.');
  const canvas = (html: string): HearingRouteResult => ({
    kind: 'html',
    status: 200,
    html,
    headers: {
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    },
  });
  const ready = versionedCanvas || ctx.ledger?.canvas(storage.namespace, record, locale);
  return ready ? canvas(ready) : renderCurrentHearingCanvas(record, locale).then(canvas);
}

/** HT-01/06: the hearing record (labels in the request locale), its
 * completion proof and what to ask next. `GET /api/hearing/:session`. */
export function readHearingSession(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  query: HearingQuery
): HearingRouteResult {
  const sessionId = hearingSessionId(rawSessionId);
  const storage = ctx.storage();
  const locale = hearingQueryLocale(query);
  const existing = storage.load(sessionId);
  assertHearingLedgerServed(ctx.ledger, existing?.scenario);
  // WI-08: same `?scenario_id=` default-record seam as the canvas route.
  const scenarioParam = resolveReadScenarioParam(ctx.ledger, storage.namespace, query.scenario_id);
  const record =
    existing ||
    defaultHearingRecord(sessionId, nowIso(), scenarioParam ?? defaultCatalogScenario());
  const completion = hearingCompletionOptions(ctx);
  return {
    kind: 'json',
    status: 200,
    headers: NO_STORE,
    body: {
      ok: true,
      record: withResolvedLabels(
        withHearingHandoffSnapshot(record, ctx.viewer, completion),
        locale
      ),
      completion: readHearingCompletion(record, ctx.viewer, completion),
      persisted: Boolean(existing),
      canvas_url: hearingCanvasUrl(sessionId, record, ctx, locale),
      ...nextQuestionPayload(record, locale),
    },
  };
}

/** HT-01/02: record one answer and redraw the canvas. `POST /api/hearing/:session/answer`.
 * Synchronous unless the scenario's `work_inventory_table` canvas has to render. */
export function answerHearing(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  rawBody: unknown,
  query: HearingQuery
): HearingRouteResult | Promise<HearingRouteResult> {
  const sessionId = hearingSessionId(rawSessionId);
  const body = parseHearingRequestBody(rawBody, 'hearing answer');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HearingRequestError('Hearing answer must be an object.');
  }
  const input = body as Record<string, unknown>;
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const requestId = typeof input.request_id === 'string' ? input.request_id.trim() : randomUUID();
  const locale =
    normalizeLocale(
      typeof input.locale === 'string' ? input.locale : readSurfaceStringParam(query.locale)
    ) ?? 'en';
  if (!text) throw new HearingRequestError('Hearing answer text is required.');
  const storage = ctx.storage();
  const namespace = storage.namespace;
  const existing = storage.load(sessionId);
  assertHearingLedgerServed(ctx.ledger, existing?.scenario);
  assertHearingEditable(existing);
  // SD-02: `scenario_ref` (`decisions-<case>-<actor>`) is resolved server-side
  // from the viewer's tenant ledger — the client never supplies the
  // decision items themselves; a non-ledger ref names a catalog sheet.
  // WI-08: `scenario_id` (resolved against `hearing-scenarios.json`) is
  // next; the legacy inline `scenario` object stays supported for
  // backward compatibility, but only when neither was sent.
  const scenarioRef = typeof input.scenario_ref === 'string' ? input.scenario_ref.trim() : '';
  const scenarioFromRef = scenarioRef
    ? (ledgerScenarioRef(ctx.ledger, namespace, scenarioRef) ??
      resolveCatalogScenarioRef(scenarioRef))
    : undefined;
  if (scenarioRef && !scenarioFromRef) {
    throw new HearingRequestError('Unknown hearing scenario.');
  }
  const scenarioFromId = scenarioFromRef
    ? undefined
    : resolveHearingScenarioParam(input.scenario_id);
  const legacyScenario =
    !scenarioFromRef &&
    !scenarioFromId &&
    input.scenario &&
    typeof input.scenario === 'object' &&
    !Array.isArray(input.scenario)
      ? (input.scenario as HearingScenario)
      : undefined;
  const scenario = scenarioFromRef || scenarioFromId || legacyScenario;
  // However the scenario arrived (ref, id or the legacy inline object), a
  // decision-ledger scenario needs this surface's ledger reads.
  assertHearingLedgerServed(ctx.ledger, scenario?.id);
  if (scenario) validateHearingScenario(scenario);
  // New sessions open on the catalog's default sheet (phase-structured),
  // not the flat built-in list.
  const record =
    existing || createHearingRecord(sessionId, nowIso(), scenario ?? defaultCatalogScenario());
  const next = applyHearingTurn(
    record,
    {
      text,
      request_id: requestId,
      ...(input.intent_resolution && typeof input.intent_resolution === 'object'
        ? { intent_resolution: input.intent_resolution as IntentResolutionContract }
        : {}),
    },
    nowIso(),
    scenario || hearingScenarioFromRecord(record)
  );
  assertHearingLedgerServed(ctx.ledger, next.scenario);
  // HT-02: save the deterministic template canvas synchronously first —
  // `canvas_url` always works even while a model generation is pending
  // or fails — then kick off the (possibly slow) model generation
  // without making the caller wait for it (risk table §4).
  // SD-05: a ledger hearing's canvas is a deterministic projection of the
  // tenant's decision ledger — drawn synchronously, final, and never
  // handed to the model. WI-08: a `work_inventory_table` scenario has no
  // model-generation follow-up either (`renderCurrentHearingCanvas` is the
  // scenario's only, final canvas), so it is `'template'`-final at once —
  // never left stuck at `'pending'` the way `web_app_preview` briefly is
  // while `scheduleHearingCanvasGeneration` runs.
  const scenarioDef = findHearingScenario(next.scenario);
  const projected = ctx.ledger?.canvas(namespace, next, locale);
  const isWorkInventory = !projected && scenarioDef?.canvas === 'work_inventory_table';
  const commit = (canvasHtml: string): HearingRouteResult => {
    const versioned = storage.commitTurn(
      sessionId,
      existing,
      next,
      canvasHtml,
      projected ? 'projected' : isWorkInventory ? 'template' : 'pending'
    );
    return {
      kind: 'json',
      status: 200,
      body: {
        ok: true,
        record: withResolvedLabels(
          withHearingHandoffSnapshot(versioned, ctx.viewer, hearingCompletionOptions(ctx)),
          locale
        ),
        canvas_url: hearingCanvasUrl(sessionId, versioned, ctx, locale),
        ...nextQuestionPayload(versioned, locale),
      },
      // Only scenarios that keep the model-drawn `web_app_preview` canvas
      // schedule the async generation follow-up.
      ...(!projected && !isWorkInventory
        ? {
            after: () =>
              scheduleHearingCanvasGeneration({
                storage,
                namespace,
                record: versioned,
                locale,
                tenantSlug: tenantSlugForHearingDesign(ctx.viewer),
                surface: ctx.currentSurface,
              }),
          }
        : {}),
    };
  };
  if (projected !== undefined) return commit(projected);
  return isWorkInventory
    ? renderWorkInventoryCanvasHtml(next, locale).then(commit)
    : commit(renderHearingCanvas(next, locale));
}

/** HT-03 / FD-10 item 4: record the human decision before handing the
 * requirements to the governed alignment/mission flow. Never creates mission
 * state. The deciding member is resolved server-side from the viewer, never
 * trusted from the request body, and an unregistered principal is refused.
 * `POST /api/hearing/:session/decide`. */
export function decideHearing(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  rawBody: unknown,
  query: HearingQuery
): HearingRouteResult {
  const sessionId = hearingSessionId(rawSessionId);
  const storage = ctx.storage();
  const namespace = storage.namespace;
  // A surface without ledger reads loads the record first (the exact-operation
  // path otherwise loads it only inside the write).
  if (!ctx.ledger) assertHearingLedgerServed(ctx.ledger, storage.load(sessionId)?.scenario);
  const operation = parseHearingDecisionOperation(
    parseHearingRequestBody(rawBody ?? {}, 'hearing decision')
  );
  let legacySnapshot: HearingRecord | undefined;
  if (!operation) {
    const record = storage.load(sessionId);
    if (!record) throw new HearingRequestError('Hearing record does not exist yet.');
    if (record.requirements.some((item) => !item.answer?.trim()))
      throw new HearingRequestError('Hearing has unanswered requirements.');
    legacySnapshot = record;
  }
  const { decidedBy, identity } = hearingDecisionActor(ctx, namespace);
  const decided = storage.decide(
    sessionId,
    operation,
    identity,
    decidedBy,
    nowIso(),
    legacySnapshot
  );
  const proof = operation ? hearingDecisionReceipt(decided, namespace, operation, identity) : null;
  if (proof?.status === 'superseded')
    return {
      kind: 'json',
      status: 200,
      headers: NO_STORE,
      body: { ok: true, decision_receipt: proof },
    };
  const locale = hearingQueryLocale(query);
  return {
    kind: 'json',
    status: 200,
    headers: NO_STORE,
    body: {
      ok: true,
      ...(proof ? { decision_receipt: proof } : {}),
      record: withResolvedLabels(
        withHearingHandoffSnapshot(decided, ctx.viewer, hearingCompletionOptions(ctx)),
        locale
      ),
      next_action: {
        kind: 'alignment_review',
        label_key: 'front_desk:hearing_next_alignment',
        label: catalogT('front_desk:hearing_next_alignment', undefined, locale),
      },
    },
  };
}

/** Read-only exact receipt proof. Absence is unknown, never evidence of non-execution.
 * `GET /api/hearing/:session/decision-receipts/:operation`. */
export function readHearingDecisionReceipt(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  rawOperationId: unknown,
  query: HearingQuery
): HearingRouteResult {
  const storage = ctx.storage();
  const namespace = storage.namespace;
  const sessionId = hearingSessionId(rawSessionId);
  const { identity } = hearingDecisionActor(ctx, namespace);
  const revision = readSurfaceStringParam(query.requirements_revision);
  if (!revision || !/^(0|[1-9][0-9]*)$/u.test(revision))
    throw new HearingRequestError('Requirements revision is required.');
  const operation = parseHearingDecisionOperation({
    version: Number(readSurfaceStringParam(query.version)),
    operation_id: rawOperationId,
    scenario_id: readSurfaceStringParam(query.scenario_id),
    requirements_revision: Number(revision),
  });
  if (!operation) throw new HearingRequestError('Exact decision operation is required.');
  const stored = storage.load(sessionId);
  assertHearingLedgerServed(ctx.ledger, stored?.scenario);
  const proof = hearingDecisionReceipt(stored, namespace, operation, identity);
  return proof
    ? { kind: 'json', status: 200, headers: NO_STORE, body: { ok: true, decision_receipt: proof } }
    : {
        kind: 'json',
        status: 404,
        headers: NO_STORE,
        body: { ok: false, decision_receipt_status: 'unknown' },
      };
}

/**
 * WI-08: confirm-and-save a decided `work_inventory` hearing record as a
 * work-inventory entry. Owner only, same posture as `/decide` and the mission
 * `/handoff`; idempotent per session (the created `entry_id` is stored on the
 * hearing record and returned again on a repeat call). Refuses any scenario
 * that is not registered with `handoff: 'work_inventory'`.
 * `POST /api/hearing/:session/inventory`. A failure after the effect was
 * reserved is reported as `handoff_unresolved` (never a retryable error).
 */
export function saveHearingInventory(
  ctx: HearingRouteContext,
  rawSessionId: unknown,
  rawBody: unknown,
  query: HearingQuery
): HearingRouteResult | Promise<HearingRouteResult> {
  const sessionId = hearingSessionId(rawSessionId);
  const storage = ctx.storage();
  const locale = hearingQueryLocale(query);

  const record = storage.load(sessionId) as HearingRecordWithInventoryFields | null;
  assertHearingLedgerServed(ctx.ledger, record?.scenario);
  if (!record) throw new HearingRequestError('Hearing record does not exist yet.');

  const scenarioDef = findHearingScenario(record.scenario);
  if (!scenarioDef || scenarioDef.handoff !== 'work_inventory') {
    throw new HearingRequestError(
      'This hearing scenario is not handed off as a work inventory entry.'
    );
  }

  // Idempotent: a session already saved returns the same entry instead
  // of writing a second one.
  assertHearingHandoffReplay(record, 'inventory');
  const completion = hearingCompletionOptions(ctx);
  const handoffSnapshot = assertHearingHandoffSnapshot(
    parseHearingRequestBody(rawBody, 'hearing handoff'),
    record,
    ctx.viewer,
    completion
  );
  if (record.work_inventory_entry_id) {
    return {
      kind: 'json',
      status: 200,
      body: {
        ok: true,
        entry_id: record.work_inventory_entry_id,
        scope: record.work_inventory_scope ?? {},
        steps: record.work_inventory_steps ?? 0,
        next: buildWorkInventoryNextAction(locale, ctx),
      },
    };
  }

  assertHearingEditable(record);

  const incomplete = record.requirements.filter((item) => !item.answer?.trim());
  if (incomplete.length > 0) {
    throw new HearingRequestError(
      `Hearing still has ${incomplete.length} unanswered requirement(s).`
    );
  }
  if (!record.decided_by || !record.decided_at) {
    throw new HearingRequestError(
      'Hearing record must be decided (POST .../decide) before creating a work inventory entry.'
    );
  }

  const scope = workInventoryScopeForHandoff(ctx);
  const input = buildWorkInventoryDecompositionInput(record, { scope });
  return proposeWorkDecomposition(input, { useModel: true }).then((result) => {
    let effectReserved = false;
    try {
      // Preparation may outlive the initiating actor's current membership.
      assertHearingHandoffSnapshot(
        { handoff_snapshot: handoffSnapshot },
        record,
        ctx.viewer,
        completion
      );
      if (JSON.stringify(workInventoryScopeForHandoff(ctx)) !== JSON.stringify(scope))
        throw new HearingScopeError('hearing_scope_unavailable');
      const reserved = storage.reserve(record, 'inventory', nowIso());
      effectReserved = true;
      // Writing a `knowledge/confidential/<tenant>/work-inventory/` entry is
      // a governed confidential-tier write, not a plain surface-runtime one
      // — elevate only for this write. `mode: 'create'`: a new entry never
      // overwrites an existing one.
      const entry = withExecutionContext(
        'ecosystem_architect',
        () =>
          saveWorkInventoryEntry(
            {
              ...result.entry,
              scope,
              status: 'confirmed',
              observations: [
                ...(result.entry.observations ?? []),
                {
                  source: 'self_report' as const,
                  ref: `hearing:${record.session_id}`,
                  observed_at: nowIso(),
                },
              ],
            },
            { mode: 'create' }
          ),
        undefined,
        scope.tenant_slug
      );

      const patch: Partial<HearingRecordWithInventoryFields> = {
        work_inventory_entry_id: entry.entry_id,
        work_inventory_scope: entry.scope,
        work_inventory_steps: entry.steps.length,
        updated_at: nowIso(),
      };
      storage.finish(reserved, patch);

      ctx.audit('info', 'hearing.inventory.create', {
        entry_id: entry.entry_id,
        steps: entry.steps.length,
      });

      return {
        kind: 'json',
        status: 200,
        body: {
          ok: true,
          entry_id: entry.entry_id,
          scope: entry.scope,
          steps: entry.steps.length,
          next: buildWorkInventoryNextAction(locale, ctx),
        },
      } satisfies HearingRouteResult;
    } catch (error) {
      if (effectReserved) {
        ctx.audit('warn', 'hearing.inventory.unresolved', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new HearingConflictError('handoff_unresolved');
      }
      throw error;
    }
  });
}
