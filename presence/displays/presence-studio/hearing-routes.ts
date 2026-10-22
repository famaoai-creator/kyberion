// HT-01/03/04: hearing session routes, split into their own module the same
// way `front-desk-routes.ts` was split out of `server.ts` — registered from
// `server.ts` at the position these routes were dropped from during the
// front-desk route/page split (see
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2/§2.3). `registerHearingRoutes` is called once, after the same
// `/api` + `/a2ui` guard and rate limiter every other API route runs behind.
import type express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { nowIso } from '@agent/core/foundation';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { normalizeLocale, type SupportedLocale } from '@agent/core/locale-normalize';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { humanActor } from '@agent/core/actor';
import { resolveMemberByPrincipal } from '@agent/core/organization/member-registry';
import { frontDeskRoleFromViewerScope, type FrontDeskRole } from '@agent/core/front-desk-identity';
import { resolveFrontDeskMenu, readFrontDeskSurfaceUrls } from '@agent/core/front-desk-nav';
import type { IntentResolutionContract } from '@agent/core/intent/intent-resolution-contract-parser';
import {
  defaultHearingScenario,
  findHearingScenario,
  hearingPhaseProgress,
} from '@agent/core/hearing-scenario-catalog';
import { proposeWorkDecomposition } from '@agent/core/workforce/work-inventory-decompose';
import {
  saveWorkInventoryEntry,
  WorkInventoryStoreError,
  type WorkInventoryScope,
} from '@agent/core/workforce/work-inventory';
import { resolveWorkInventoryScopeForViewer } from './work-inventory-routes.js';
import {
  PresenceStudioViewerError,
  requirePresenceStudioLocalAdmin,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
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
import {
  hearingStorageForViewer,
  hearingDecisionScopeKey,
  type HearingStorage,
} from './hearing-storage-access.js';
import { generateHearingCanvas } from './hearing-canvas.js';
import {
  buildWorkInventoryDecompositionInput,
  renderWorkInventoryCanvasHtml,
} from './hearing-work-inventory.js';
import {
  HearingLedgerRequestError,
  renderLedgerCanvasForRecord,
  resolveLedgerScenarioRef,
} from './hearing-ledger-routes.js';
import { parseDecisionsScenarioId } from '@agent/core/decision-ledger';
import * as presenceStudioData from './presence-studio-runtime-data.js';
import { readHearingCompletion } from './hearing-completion.js';
import {
  resolveHearingRequestViewer,
  resolveHearingHandoffScope,
  hearingScopedUrl,
  HearingScopeError,
} from './hearing-request-scope.js';
import {
  assertHearingHandoffSnapshot,
  withHearingHandoffSnapshot,
} from './hearing-handoff-snapshot.js';

class HearingRequestError extends Error {
  readonly status = 400 as const;
}

/** WI-08: additive fields this route owns on the hearing record, mirroring
 * `hearing-mission-routes.ts`'s `HearingMissionHandoffFields` intersection
 * — `hearing.ts` (the base `HearingRecord` contract) is the concurrent
 * sibling's file, so these are only ever read/written here, never added to
 * the base interface. */
export interface HearingWorkInventoryHandoffFields {
  work_inventory_entry_id?: string;
  work_inventory_scope?: WorkInventoryScope;
  work_inventory_steps?: number;
}

export type HearingRecordWithInventoryFields = HearingRecord & HearingWorkInventoryHandoffFields;

function hearingSessionId(req: Request): string {
  const sessionId = String(req.params.session || '').trim();
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

/** Read routes: a ledger id resolves from the viewer's tenant ledger so the unpersisted default
 * record carries the same `scenario` the client validates accepted records against. */
function resolveReadScenarioParam(
  namespace: string,
  scenarioId: unknown
): HearingScenario | undefined {
  const id = typeof scenarioId === 'string' ? scenarioId.trim() : '';
  if (id && parseDecisionsScenarioId(id)) return resolveLedgerScenarioRef(namespace, id);
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
 * platform-wide viewer (`namespace === 'all'`) has no single tenant/personal
 * scope to file the entry under, so it is refused the same way
 * `hearing-mission-routes.ts` refuses a mission hand-off without a concrete
 * tenant. Mirrors `hearing-runtime.ts`'s `hearingNamespace` resolution:
 * first tenant slug -> tenant scope; `'unscoped'` (no tenant) -> personal
 * scope. */
function workInventoryScopeForHandoff(viewer: PresenceStudioViewerContext): WorkInventoryScope {
  const destination = resolveHearingHandoffScope(viewer, 'inventory');
  const scope = resolveWorkInventoryScopeForViewer(viewer);
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

function buildWorkInventoryNextAction(
  locale: SupportedLocale,
  viewer: PresenceStudioViewerContext
) {
  const progressItem = resolveFrontDeskMenu({
    currentSurface: 'presence-studio',
    urls: readFrontDeskSurfaceUrls(),
    role: frontDeskRoleFromViewerScope(toFrontDeskViewerScope(viewer)),
  }).find((item) => item.id === 'progress');
  return {
    label_key: 'front_desk:hearing_inventory_open' as const,
    label: catalogT('front_desk:hearing_inventory_open', undefined, locale),
    href: progressItem?.allowed ? hearingScopedUrl(progressItem.href, viewer) : '',
  };
}

/** HT-06: the JSON `record` payload resolves each requirement's `label_key`
 * to the request's locale at response time — never persisted — so a locale
 * change re-renders instead of freezing the answering locale. */
function withResolvedLabels(
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

export function defaultCatalogScenario(): HearingScenario {
  return hearingScenarioFromCatalogEntry(defaultHearingScenario());
}

/** Per-phase progress with resolved titles — the sheet's "where are we". */
function phasePayload(record: HearingRecord, locale: SupportedLocale) {
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
function nextQuestionPayload(record: HearingRecord, locale: SupportedLocale) {
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
  viewer: PresenceStudioViewerContext,
  locale: SupportedLocale
): string {
  const latest = record.canvas_versions[record.canvas_versions.length - 1];
  const base = `/api/hearing/${encodeURIComponent(sessionId)}/canvas`;
  const params = new URLSearchParams();
  params.set('scenario_id', record.scenario);
  if (latest) params.set('version', latest);
  params.set('locale', locale);
  return hearingScopedUrl(`${base}?${params.toString()}`, viewer);
}

function hearingResponseError(req: Request, res: Response, error: unknown): void {
  const status =
    error instanceof HearingConflictError
      ? 409
      : error instanceof HearingRequestError ||
          error instanceof HearingLedgerRequestError ||
          error instanceof HearingOperationError ||
          error instanceof HearingScopeError
        ? error.status
        : error instanceof PresenceStudioViewerError
          ? error.status
          : error instanceof WorkInventoryStoreError
            ? 409
            : 500;
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json({
    ...presenceStudioData.presenceStudioWireError(error, status),
    ...(error instanceof HearingConflictError ? { hearing_conflict: error.conflict } : {}),
    ...(error instanceof HearingScopeError ? { hearing_scope_error: error.code } : {}),
  });
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
  viewer: PresenceStudioViewerContext
): FrontDeskRole {
  if (namespace !== 'all' && namespace !== 'unscoped') {
    const membership = member.memberships.find((item) => item.tenant_slug === namespace);
    return membership?.role ?? 'viewer';
  }
  return frontDeskRoleFromViewerScope(toFrontDeskViewerScope(viewer));
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
}

const hearingCanvasInFlight = new Map<string, HearingCanvasGenerationJob | undefined>();

function hearingCanvasJobKey(namespace: string, sessionId: string): string {
  return `${namespace}:${sessionId}`;
}

function tenantSlugForHearingDesign(viewer: PresenceStudioViewerContext): string | undefined {
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
        `[presence-studio] hearing canvas generation failed for ${job.record.session_id}: ${
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
  viewer: PresenceStudioViewerContext,
  namespace: string
): {
  decidedBy: HearingDecidedBy;
  identity: HearingDecisionIdentity;
} {
  const member = withExecutionContext('ecosystem_architect', () =>
    resolveMemberByPrincipal({
      principalId: viewer.principalId,
      source: viewer.source,
      registrationLabel: viewer.principal?.registrationLabel,
      memberId: viewer.principal?.memberId,
    })
  );
  if (!member) {
    throw new PresenceStudioViewerError(403, 'decisions are recorded for registered members only');
  }
  const role = resolveHearingDeciderRole(member, namespace, viewer);
  if (role !== 'owner' && role !== 'approver') {
    // Positive allowlist: only decision-capable membership roles may
    // record a decision (`surface.decision.write` is granted to owner and
    // approver only — front-desk-roles.ts). Operators execute but never
    // decide; viewers observe.
    throw new PresenceStudioViewerError(403, 'this member role cannot record decisions');
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
      principal_id: viewer.principalId,
      member_id: member.member_id,
      source: viewer.source,
      scope_key: hearingDecisionScopeKey(viewer),
    },
  };
}

export function registerHearingRoutes(app: express.Express): void {
  // HT-01: read-only hearing record and deterministic fixed canvas. A missing
  // record is returned as an in-memory default and persisted after the first
  // answer mutation.
  app.get('/api/hearing/:session/canvas', async (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      const sessionId = hearingSessionId(req);
      const storage = hearingStorageForViewer(viewer);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      // WI-08: before the first answer there is no persisted record yet —
      // `?scenario_id=` (the same id `/ask?mode=hearing&scenario=...` picked)
      // lets the default in-memory record reflect the chosen scenario
      // instead of always defaulting to `web_app_build`.
      const scenarioParam = resolveReadScenarioParam(storage.namespace, req.query.scenario_id);
      const record =
        storage.load(sessionId) || defaultHearingRecord(sessionId, nowIso(), scenarioParam);
      const requestedVersion = typeof req.query.version === 'string' ? req.query.version : '';
      const versionedCanvas = requestedVersion ? storage.canvas(sessionId, requestedVersion) : null;
      if (requestedVersion && !versionedCanvas)
        throw new HearingRequestError('Hearing canvas version was not found.');
      const html =
        versionedCanvas ||
        renderLedgerCanvasForRecord(storage.namespace, record, locale) ||
        (await renderCurrentHearingCanvas(record, locale));
      res.type('html');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
      );
      res.send(html);
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // HT-06: `?locale=` mirrors the locale the page already sends to
  // `/api/ask-vocabulary` — every requirement's `label_key` is resolved to
  // that locale's text server-side (`withResolvedLabels`) without touching
  // the persisted `label_key`, so a later locale change re-renders instead
  // of freezing the answering locale.
  app.get('/api/hearing/:session', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      const sessionId = hearingSessionId(req);
      const storage = hearingStorageForViewer(viewer);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const existing = storage.load(sessionId);
      // WI-08: same `?scenario_id=` default-record seam as the canvas route.
      const scenarioParam = resolveReadScenarioParam(storage.namespace, req.query.scenario_id);
      const record =
        existing ||
        defaultHearingRecord(sessionId, nowIso(), scenarioParam ?? defaultCatalogScenario());
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        record: withResolvedLabels(withHearingHandoffSnapshot(record, viewer), locale),
        completion: readHearingCompletion(record, viewer),
        persisted: Boolean(existing),
        canvas_url: hearingCanvasUrl(sessionId, record, viewer, locale),
        ...nextQuestionPayload(record, locale),
      });
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  app.post('/api/hearing/:session/answer', async (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingSessionId(req);
      const body = presenceStudioData.safeParsePresenceStudioRequestBody(
        req.body,
        'hearing answer'
      );
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HearingRequestError('Hearing answer must be an object.');
      }
      const input = body as Record<string, unknown>;
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      const requestId =
        typeof input.request_id === 'string' ? input.request_id.trim() : randomUUID();
      const locale =
        normalizeLocale(
          typeof input.locale === 'string' ? input.locale : readSurfaceStringParam(req.query.locale)
        ) ?? 'en';
      if (!text) throw new HearingRequestError('Hearing answer text is required.');
      const storage = hearingStorageForViewer(viewer);
      const namespace = storage.namespace;
      const existing = storage.load(sessionId);
      assertHearingEditable(existing);
      // SD-02: `scenario_ref` (`decisions-<case>-<actor>`) is resolved server-side
      // from the viewer's tenant ledger — the client never supplies the
      // decision items themselves; a non-ledger ref names a catalog sheet.
      // WI-08: `scenario_id` (resolved against `hearing-scenarios.json`) is
      // next; the legacy inline `scenario` object stays supported for
      // backward compatibility, but only when neither was sent.
      const scenarioRef = typeof input.scenario_ref === 'string' ? input.scenario_ref.trim() : '';
      const scenarioFromRef = scenarioRef
        ? (resolveLedgerScenarioRef(namespace, scenarioRef) ??
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
      const projected = renderLedgerCanvasForRecord(namespace, next, locale);
      const isWorkInventory = !projected && scenarioDef?.canvas === 'work_inventory_table';
      const canvasHtml =
        projected ??
        (isWorkInventory
          ? await renderWorkInventoryCanvasHtml(next, locale)
          : renderHearingCanvas(next, locale));
      const versioned = storage.commitTurn(
        sessionId,
        existing,
        next,
        canvasHtml,
        projected ? 'projected' : isWorkInventory ? 'template' : 'pending'
      );
      res.status(200).json({
        ok: true,
        record: withResolvedLabels(withHearingHandoffSnapshot(versioned, viewer), locale),
        canvas_url: hearingCanvasUrl(sessionId, versioned, viewer, locale),
        ...nextQuestionPayload(versioned, locale),
      });
      // Only scenarios that keep the model-drawn `web_app_preview` canvas
      // schedule the async generation follow-up.
      if (!projected && !isWorkInventory) {
        scheduleHearingCanvasGeneration({
          storage,
          namespace,
          record: versioned,
          locale,
          tenantSlug: tenantSlugForHearingDesign(viewer),
        });
      }
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // HT-03 / FD-10 item 4: record the human decision before handing the
  // requirements to the governed alignment/mission flow. This endpoint never
  // creates mission state. Decisions are human-only (front-desk plan §2.5
  // principle 4): the deciding member is resolved server-side from the
  // viewer, never trusted from the request body, and an unregistered
  // principal is refused rather than silently recorded under its synthetic
  // loopback/token principal id.
  app.post('/api/hearing/:session/decide', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingSessionId(req);
      const storage = hearingStorageForViewer(viewer);
      const namespace = storage.namespace;
      const operation = parseHearingDecisionOperation(
        presenceStudioData.safeParsePresenceStudioRequestBody(req.body ?? {}, 'hearing decision')
      );
      let legacySnapshot: HearingRecord | undefined;
      if (!operation) {
        const record = storage.load(sessionId);
        if (!record) throw new HearingRequestError('Hearing record does not exist yet.');
        if (record.requirements.some((item) => !item.answer?.trim()))
          throw new HearingRequestError('Hearing has unanswered requirements.');
        legacySnapshot = record;
      }
      const { decidedBy, identity } = hearingDecisionActor(viewer, namespace);
      const decided = storage.decide(
        sessionId,
        operation,
        identity,
        decidedBy,
        nowIso(),
        legacySnapshot
      );
      const proof = operation
        ? hearingDecisionReceipt(decided, namespace, operation, identity)
        : null;
      res.setHeader('Cache-Control', 'no-store');
      if (proof?.status === 'superseded') return res.json({ ok: true, decision_receipt: proof });
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      return res.json({
        ok: true,
        ...(proof ? { decision_receipt: proof } : {}),
        record: withResolvedLabels(withHearingHandoffSnapshot(decided, viewer), locale),
        next_action: {
          kind: 'alignment_review',
          label_key: 'front_desk:hearing_next_alignment',
          label: catalogT('front_desk:hearing_next_alignment', undefined, locale),
        },
      });
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // Read-only exact receipt proof. Absence is unknown, never evidence of non-execution.
  app.get('/api/hearing/:session/decision-receipts/:operation', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const storage = hearingStorageForViewer(viewer);
      const namespace = storage.namespace;
      const sessionId = hearingSessionId(req);
      const { identity } = hearingDecisionActor(viewer, namespace);
      const revision = readSurfaceStringParam(req.query.requirements_revision);
      if (!revision || !/^(0|[1-9][0-9]*)$/u.test(revision))
        throw new HearingRequestError('Requirements revision is required.');
      const operation = parseHearingDecisionOperation({
        version: Number(readSurfaceStringParam(req.query.version)),
        operation_id: req.params.operation,
        scenario_id: readSurfaceStringParam(req.query.scenario_id),
        requirements_revision: Number(revision),
      });
      if (!operation) throw new HearingRequestError('Exact decision operation is required.');
      const proof = hearingDecisionReceipt(storage.load(sessionId), namespace, operation, identity);
      res.setHeader('Cache-Control', 'no-store');
      return proof
        ? res.json({ ok: true, decision_receipt: proof })
        : res.status(404).json({ ok: false, decision_receipt_status: 'unknown' });
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // WI-08: confirm-and-save a decided `work_inventory` hearing record as a
  // work-inventory entry. Localadmin only, same posture as `/decide` and the
  // mission `/handoff` route; idempotent per session (the created
  // `entry_id` is stored on the hearing record and returned again on a
  // repeat call, mirroring `hearing-mission-routes.ts`'s `mission_id`
  // idempotency). Refuses any scenario that is not registered with
  // `handoff: 'work_inventory'` in `hearing-scenarios.json` — the mission
  // `/handoff` route in `hearing-mission-routes.ts` carries the matching
  // refusal for `handoff: 'work_inventory'` scenarios.
  app.post('/api/hearing/:session/inventory', async (req, res) => {
    let effectReserved = false;
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingSessionId(req);
      const storage = hearingStorageForViewer(viewer);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';

      const record = storage.load(sessionId) as HearingRecordWithInventoryFields | null;
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
      const handoffSnapshot = assertHearingHandoffSnapshot(
        presenceStudioData.safeParsePresenceStudioRequestBody(req.body, 'hearing handoff'),
        record,
        viewer
      );
      if (record.work_inventory_entry_id) {
        res.status(200).json({
          ok: true,
          entry_id: record.work_inventory_entry_id,
          scope: record.work_inventory_scope ?? {},
          steps: record.work_inventory_steps ?? 0,
          next: buildWorkInventoryNextAction(locale, viewer),
        });
        return;
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

      const scope = workInventoryScopeForHandoff(viewer);
      const input = buildWorkInventoryDecompositionInput(record, { scope });
      const result = await proposeWorkDecomposition(input, { useModel: true });
      // Preparation may outlive the initiating actor's current membership.
      assertHearingHandoffSnapshot({ handoff_snapshot: handoffSnapshot }, record, viewer);
      if (JSON.stringify(workInventoryScopeForHandoff(viewer)) !== JSON.stringify(scope))
        throw new HearingScopeError('hearing_scope_unavailable');
      const reserved = storage.reserve(record, 'inventory', nowIso());
      effectReserved = true;
      // Writing a `knowledge/confidential/<tenant>/work-inventory/` entry is
      // a governed confidential-tier write, not a plain surface-runtime one
      // — elevate only for this write, the same pattern `training-routes.ts`
      // uses for its own confidential-tier assignment writes and
      // `hearing-mission-routes.ts` uses for its mission-evidence write.
      // `mode: 'create'`: a new entry never overwrites an existing one.
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

      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'hearing.inventory.create', {
          entry_id: entry.entry_id,
          steps: entry.steps.length,
        })
      );

      res.status(200).json({
        ok: true,
        entry_id: entry.entry_id,
        scope: entry.scope,
        steps: entry.steps.length,
        next: buildWorkInventoryNextAction(locale, viewer),
      });
    } catch (error) {
      if (effectReserved) {
        logger.warn(
          presenceStudioData.presenceStudioAuditLine(req, 'hearing.inventory.unresolved', {
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      hearingResponseError(
        req,
        res,
        effectReserved ? new HearingConflictError('handoff_unresolved') : error
      );
    }
  });
}
