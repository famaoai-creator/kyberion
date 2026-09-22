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
import { readSurfaceStringParam } from '@agent/core/surface-request-input';
import { withExecutionContext } from '@agent/core/authority';
import { logger } from '@agent/core/core';
import { humanActor } from '@agent/core/actor';
import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import { frontDeskRoleFromViewerScope, type FrontDeskRole } from '@agent/core/front-desk-identity';
import { FRONT_DESK_MENU, readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';
import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';
import {
  findHearingScenario,
  type HearingScenarioCatalogEntry,
} from '@agent/core/hearing-scenario-catalog';
import { proposeWorkDecomposition } from '@agent/core/work-inventory-decompose';
import { saveWorkInventoryEntry, type WorkInventoryScope } from '@agent/core/work-inventory';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import {
  applyHearingTurn,
  createHearingRecord,
  validateHearingScenario,
  type HearingDecidedBy,
  type HearingRecord,
  type HearingScenario,
} from './hearing.js';
import {
  defaultHearingRecord,
  hearingNamespace,
  loadHearingRecord,
  loadHearingCanvasVersion,
  renderHearingCanvas,
  saveHearingCanvasVersion,
  saveHearingRecord,
} from './hearing-runtime.js';
import { generateHearingCanvas } from './hearing-canvas.js';
import {
  buildWorkInventoryDecompositionInput,
  renderWorkInventoryCanvasHtml,
} from './hearing-work-inventory.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

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
    requirements: record.requirements.map(({ id, label_key }) => ({ id, label_key })),
  };
}

/** WI-08: `{id, requirements}` projection of a `hearing-scenarios.json`
 * catalog entry — the shape `createHearingRecord`/`applyHearingTurn` need. */
function hearingScenarioFromCatalogEntry(entry: HearingScenarioCatalogEntry): HearingScenario {
  return {
    id: entry.id,
    requirements: entry.requirements.map(({ id, label_key, aliases }) => ({
      id,
      label_key,
      ...(aliases ? { aliases } : {}),
    })),
  };
}

/** WI-08: resolves `scenario_id` (POST body / GET query) against
 * `hearing-scenarios.json`; an unknown id is a 400, never a silent
 * default — `undefined` (no `scenario_id` at all) leaves the caller free to
 * fall back to the existing default/`input.scenario` behavior. */
function resolveHearingScenarioParam(scenarioId: unknown): HearingScenario | undefined {
  if (typeof scenarioId !== 'string' || !scenarioId.trim()) return undefined;
  const entry = findHearingScenario(scenarioId.trim());
  if (!entry) {
    throw new HearingRequestError(`Unknown hearing scenario_id: ${scenarioId}`);
  }
  return hearingScenarioFromCatalogEntry(entry);
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
function workInventoryScopeForNamespace(namespace: string): WorkInventoryScope {
  if (namespace === 'all') {
    throw new HearingRequestError(
      'Work inventory hand-off requires a concrete tenant or personal scope.'
    );
  }
  if (namespace === 'unscoped') return {};
  return { tenant_slug: namespace };
}

/** WI-08: `?scenario_id=` on the canvas URL itself (not just the record
 * fetch) so the canvas iframe's own, separate request also resolves the
 * right default scenario before anything is persisted — the browser loads
 * this URL directly, it never carries whatever query the record fetch used. */
function hearingCanvasUrl(sessionId: string, record: HearingRecord): string {
  return `/api/hearing/${encodeURIComponent(sessionId)}/canvas?scenario_id=${encodeURIComponent(record.scenario)}`;
}

function buildWorkInventoryNextAction(locale: SupportedLocale) {
  const progressItem = FRONT_DESK_MENU.find((item) => item.id === 'progress');
  const ports = readFrontDeskSurfacePorts();
  const href = progressItem
    ? `http://127.0.0.1:${ports[progressItem.surface]}${progressItem.path}`
    : '';
  return {
    label_key: 'front_desk:hearing_inventory_open' as const,
    label: catalogT('front_desk:hearing_inventory_open', undefined, locale),
    href,
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
    requirements: record.requirements.map((item) => ({
      ...item,
      label: catalogT(item.label_key as VocabularyKey, undefined, locale),
    })),
  };
}

function hearingResponseError(req: Request, res: Response, error: unknown): void {
  const status =
    error instanceof HearingRequestError
      ? error.status
      : error instanceof PresenceStudioViewerError
        ? error.status
        : 500;
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
}

/** FD-10 (plan §2.5 principle 4): the deciding member's role comes from
 * their own per-tenant membership when one exists for the hearing's
 * namespace tenant, else the viewer-scope fallback (`frontDeskRoleFromViewerScope`)
 * `readFrontDeskMe` already uses for an unresolved-membership loopback owner. */
function resolveHearingDeciderRole(
  member: { memberships: ReadonlyArray<{ tenant_slug: string; role: FrontDeskRole }> },
  namespace: string,
  viewer: PresenceStudioViewerContext
): FrontDeskRole {
  const membership =
    namespace !== 'all' && namespace !== 'unscoped'
      ? member.memberships.find((item) => item.tenant_slug === namespace)
      : undefined;
  if (membership) return membership.role;
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
      // The latest answer wins: only apply this result if the persisted
      // record is still the exact snapshot this generation started from —
      // a newer answer's `updated_at` means this result is stale.
      const persisted = loadHearingRecord(job.namespace, job.record.session_id);
      if (!persisted || persisted.updated_at !== job.record.updated_at) return;
      if (result.source === 'generated') {
        const version = saveHearingCanvasVersion(job.namespace, persisted, result.html);
        saveHearingRecord(job.namespace, {
          ...persisted,
          canvas_versions: [...persisted.canvas_versions, version],
          canvas_generation: 'generated',
          canvas_version_sources: { ...persisted.canvas_version_sources, [version]: 'generated' },
        });
      } else {
        saveHearingRecord(job.namespace, { ...persisted, canvas_generation: 'template' });
      }
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

export function registerHearingRoutes(app: express.Express): void {
  // HT-01: read-only hearing record and deterministic fixed canvas. A missing
  // record is returned as an in-memory default and persisted after the first
  // answer mutation.
  app.get('/api/hearing/:session/canvas', async (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const sessionId = hearingSessionId(req);
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      // WI-08: before the first answer there is no persisted record yet —
      // `?scenario_id=` (the same id `/ask?mode=hearing&scenario=...` picked)
      // lets the default in-memory record reflect the chosen scenario
      // instead of always defaulting to `web_app_build`.
      const scenarioParam = resolveHearingScenarioParam(req.query.scenario_id);
      const record =
        loadHearingRecord(namespace, sessionId) ||
        defaultHearingRecord(sessionId, nowIso(), scenarioParam);
      const requestedVersion = typeof req.query.version === 'string' ? req.query.version : '';
      const versionedCanvas = requestedVersion
        ? loadHearingCanvasVersion(namespace, sessionId, requestedVersion)
        : null;
      if (requestedVersion && !versionedCanvas)
        throw new HearingRequestError('Hearing canvas version was not found.');
      const html = versionedCanvas || (await renderCurrentHearingCanvas(record, locale));
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
      const viewer = resolvePresenceStudioViewerContext(req);
      const sessionId = hearingSessionId(req);
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const existing = loadHearingRecord(namespace, sessionId);
      // WI-08: same `?scenario_id=` default-record seam as the canvas route.
      const scenarioParam = resolveHearingScenarioParam(req.query.scenario_id);
      const record = existing || defaultHearingRecord(sessionId, nowIso(), scenarioParam);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        record: withResolvedLabels(record, locale),
        persisted: Boolean(existing),
        canvas_url: hearingCanvasUrl(sessionId, record),
      });
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  app.post('/api/hearing/:session/answer', async (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
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
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const existing = loadHearingRecord(namespace, sessionId);
      // WI-08: `scenario_id` (resolved against `hearing-scenarios.json`) is
      // preferred; the legacy inline `scenario` object stays supported for
      // backward compatibility, but only when no `scenario_id` was sent.
      const scenarioFromId = resolveHearingScenarioParam(input.scenario_id);
      const legacyScenario =
        !scenarioFromId &&
        input.scenario &&
        typeof input.scenario === 'object' &&
        !Array.isArray(input.scenario)
          ? (input.scenario as HearingScenario)
          : undefined;
      if (legacyScenario) validateHearingScenario(legacyScenario);
      const scenario = scenarioFromId || legacyScenario;
      const record = existing || createHearingRecord(sessionId, nowIso(), scenario);
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
      // without making the caller wait for it (risk table §4). WI-08: a
      // `work_inventory_table` scenario has no model-generation follow-up
      // (`renderCurrentHearingCanvas` is the scenario's only, final canvas),
      // so it never suspends this handler — the ternary's `await` only runs
      // for a `work_inventory_table` scenario, which is the only branch that
      // needs it.
      const scenarioDef = findHearingScenario(next.scenario);
      const canvasHtml =
        scenarioDef?.canvas === 'work_inventory_table'
          ? await renderWorkInventoryCanvasHtml(next, locale)
          : renderHearingCanvas(next, locale);
      const canvasVersion = saveHearingCanvasVersion(namespace, next, canvasHtml);
      // WI-08: `work_inventory_table` has no async follow-up (no reasoning
      // backend call), so its canvas is `'template'`-final immediately —
      // never left stuck at `'pending'` the way `web_app_preview` briefly is
      // while `scheduleHearingCanvasGeneration` runs.
      const canvasGeneration =
        scenarioDef?.canvas === 'work_inventory_table' ? 'template' : 'pending';
      const versioned: HearingRecord = {
        ...next,
        canvas_versions: [...next.canvas_versions, canvasVersion],
        canvas_generation: canvasGeneration,
        canvas_version_sources: {
          ...next.canvas_version_sources,
          [canvasVersion]: 'template',
        },
      };
      saveHearingRecord(namespace, versioned);
      res.status(200).json({
        ok: true,
        record: withResolvedLabels(versioned, locale),
        canvas_url: hearingCanvasUrl(sessionId, versioned),
      });
      // WI-08: `work_inventory_table` never calls a reasoning backend for its
      // canvas — only scenarios that keep the model-drawn `web_app_preview`
      // canvas schedule the async generation follow-up.
      if (scenarioDef?.canvas !== 'work_inventory_table') {
        scheduleHearingCanvasGeneration({
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
      const viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingSessionId(req);
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const record = loadHearingRecord(namespace, sessionId);
      if (!record) throw new HearingRequestError('Hearing record does not exist yet.');
      const incomplete = record.requirements.filter((item) => !item.answer?.trim());
      if (incomplete.length > 0) {
        throw new HearingRequestError(
          `Hearing still has ${incomplete.length} unanswered requirement(s).`
        );
      }
      const member = withExecutionContext('ecosystem_architect', () =>
        resolveMemberByPrincipal({ principalId: viewer.principalId, source: viewer.source })
      );
      if (!member) {
        throw new PresenceStudioViewerError(
          403,
          'decisions are recorded for registered members only'
        );
      }
      const role = resolveHearingDeciderRole(member, namespace, viewer);
      const actor = humanActor(member.member_id, member.display_name);
      const decidedBy: HearingDecidedBy = {
        kind: 'human',
        id: actor.id,
        ...(actor.display_name ? { display_name: actor.display_name } : {}),
        role,
      };
      const decided = {
        ...record,
        decided_by: decidedBy,
        decided_at: nowIso(),
        updated_at: nowIso(),
      };
      saveHearingRecord(namespace, decided);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      return res.json({
        ok: true,
        record: withResolvedLabels(decided, locale),
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
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
      const sessionId = hearingSessionId(req);
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';

      const record = loadHearingRecord(
        namespace,
        sessionId
      ) as HearingRecordWithInventoryFields | null;
      if (!record) throw new HearingRequestError('Hearing record does not exist yet.');

      const scenarioDef = findHearingScenario(record.scenario);
      if (!scenarioDef || scenarioDef.handoff !== 'work_inventory') {
        throw new HearingRequestError(
          'This hearing scenario is not handed off as a work inventory entry.'
        );
      }

      // Idempotent: a session already saved returns the same entry instead
      // of writing a second one.
      if (record.work_inventory_entry_id) {
        res.status(200).json({
          ok: true,
          entry_id: record.work_inventory_entry_id,
          scope: record.work_inventory_scope ?? {},
          steps: record.work_inventory_steps ?? 0,
          next: buildWorkInventoryNextAction(locale),
        });
        return;
      }

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

      const scope = workInventoryScopeForNamespace(namespace);
      const input = buildWorkInventoryDecompositionInput(record, { scope });
      const result = await proposeWorkDecomposition(input, { useModel: true });
      // Writing a `knowledge/confidential/<tenant>/work-inventory/` entry is
      // a governed confidential-tier write, not a plain surface-runtime one
      // — elevate only for this write, the same pattern `training-routes.ts`
      // uses for its own confidential-tier assignment writes and
      // `hearing-mission-routes.ts` uses for its mission-evidence write.
      const entry = withExecutionContext('ecosystem_architect', () =>
        saveWorkInventoryEntry({
          ...result.entry,
          status: 'confirmed',
          observations: [
            ...(result.entry.observations ?? []),
            {
              source: 'self_report' as const,
              ref: `hearing:${record.session_id}`,
              observed_at: nowIso(),
            },
          ],
        })
      );

      const updated: HearingRecordWithInventoryFields = {
        ...record,
        work_inventory_entry_id: entry.entry_id,
        work_inventory_scope: entry.scope,
        work_inventory_steps: entry.steps.length,
        updated_at: nowIso(),
      };
      saveHearingRecord(namespace, updated);

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
        next: buildWorkInventoryNextAction(locale),
      });
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });
}
