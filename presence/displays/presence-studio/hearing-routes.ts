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
import type { IntentResolutionContract } from '@agent/core/intent-resolution-contract-parser';
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
import * as presenceStudioData from './presence-studio-runtime-data.js';

class HearingRequestError extends Error {
  readonly status = 400 as const;
}

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

export function registerHearingRoutes(app: express.Express): void {
  // HT-01: read-only hearing record and deterministic fixed canvas. A missing
  // record is returned as an in-memory default and persisted after the first
  // answer mutation.
  app.get('/api/hearing/:session/canvas', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const sessionId = hearingSessionId(req);
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const record =
        loadHearingRecord(namespace, sessionId) || defaultHearingRecord(sessionId, nowIso());
      const requestedVersion = typeof req.query.version === 'string' ? req.query.version : '';
      const versionedCanvas = requestedVersion
        ? loadHearingCanvasVersion(namespace, sessionId, requestedVersion)
        : null;
      if (requestedVersion && !versionedCanvas)
        throw new HearingRequestError('Hearing canvas version was not found.');
      res.type('html');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
      );
      res.send(versionedCanvas || renderHearingCanvas(record, locale));
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
      const record = existing || defaultHearingRecord(sessionId, nowIso());
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        record: withResolvedLabels(record, locale),
        persisted: Boolean(existing),
        canvas_url: `/api/hearing/${encodeURIComponent(sessionId)}/canvas`,
      });
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  app.post('/api/hearing/:session/answer', (req, res) => {
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
      const scenario =
        input.scenario && typeof input.scenario === 'object' && !Array.isArray(input.scenario)
          ? (input.scenario as HearingScenario)
          : undefined;
      if (scenario) validateHearingScenario(scenario);
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
      const canvasVersion = saveHearingCanvasVersion(
        namespace,
        next,
        renderHearingCanvas(next, locale)
      );
      const versioned = { ...next, canvas_versions: [...next.canvas_versions, canvasVersion] };
      saveHearingRecord(namespace, versioned);
      res.status(200).json({
        ok: true,
        record: withResolvedLabels(versioned, locale),
        canvas_url: `/api/hearing/${encodeURIComponent(sessionId)}/canvas`,
      });
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
}
