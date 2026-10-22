// AU-02/AU-03: the component host (A2UI COMPONENT HOST PLAN §2.3).
//
//   GET /flow/:component                 the host page (one static page for every component)
//   GET /api/components?locale=          the registry, filtered for the viewer's role, labels resolved
//   GET /api/flow-vocabulary?locale=     the host page's own chrome text
//   GET /api/headless/a2ui/hearing       the hearing flow as A2UI + action descriptors (+ input)
//
// Cross-cutting rules live here and in `security.ts`, never in a component:
// the tenant is the viewer's server-side scope, labels come from the
// vocabulary catalog, actions are headless operations the host executes.
import type express from 'express';
import type { Request, Response } from 'express';
import * as path from 'node:path';
import { nowIso } from '@agent/core/foundation';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { normalizeLocale, type SupportedLocale } from '@agent/core/locale-normalize';
import { readSurfaceStringParam } from '@agent/core/surface/surface-request-input';
import { logger } from '@agent/core/core';
import { frontDeskRoleFromViewerScope } from '@agent/core/front-desk-identity';
import { FRONT_DESK_MENU, readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';
import { hearingPhaseProgress } from '@agent/core/hearing-scenario-catalog';
import {
  listUiComponents,
  type UiComponent,
  type UiComponentRole,
} from '@agent/core/ui-component-registry';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import { authorizePresenceOperation, presenceEnvelope } from './headless.js';
import { defaultHearingRecord, hearingNamespace, loadHearingRecord } from './hearing-runtime.js';
import { HEARING_SAFE_ID_PATTERN, nextHearingQuestion, type HearingRecord } from './hearing.js';
import { buildHearingA2UI } from './hearing-a2ui.js';
import { defaultCatalogScenario } from './hearing-routes.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';
import { presenceStudioAuthRateLimiter } from './surface-auth.js';

class ComponentHostRequestError extends Error {
  readonly status = 400 as const;
}

export const FLOW_VOCABULARY_KEYS = [
  'front_desk:flow_title',
  'front_desk:flow_components_title',
  'front_desk:flow_input_placeholder',
  'front_desk:flow_send',
  'front_desk:flow_loading',
  'front_desk:flow_unsupported',
  'front_desk:flow_action_failed',
  'front_desk:flow_status_a2ui',
  'front_desk:flow_status_page',
  'front_desk:flow_status_planned',
  'front_desk:flow_new_session',
] as const satisfies readonly VocabularyKey[];

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,60}$/u;

function respondError(req: Request, res: Response, error: unknown): void {
  const status =
    error instanceof ComponentHostRequestError
      ? error.status
      : error instanceof PresenceStudioViewerError
        ? error.status
        : 500;
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'component-host.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
}

function viewerRole(viewer: PresenceStudioViewerContext): UiComponentRole {
  const role = frontDeskRoleFromViewerScope(toFrontDeskViewerScope(viewer));
  // An operator executes but never decides (front-desk-roles.ts), so for
  // component visibility it ranks with viewers: approver-gated components are
  // decision surfaces.
  return role === 'operator' ? 'viewer' : role;
}

/** A component's `href` for the host menu: an A2UI component opens in this host, a page opens its surface. */
function componentHref(component: UiComponent): string | undefined {
  if (component.status === 'a2ui') return `/flow/${component.id}`;
  if (component.status === 'page' && component.entry?.page_path) {
    if (!component.entry.page_surface || component.entry.page_surface === 'presence-studio') {
      return component.entry.page_path;
    }
    const ports = readFrontDeskSurfacePorts();
    const port = component.entry.page_surface === 'concierge' ? ports.concierge : undefined;
    return port ? `http://127.0.0.1:${port}${component.entry.page_path}` : undefined;
  }
  return undefined;
}

export function describeComponentsForViewer(
  viewer: PresenceStudioViewerContext,
  locale: SupportedLocale
) {
  const role = viewerRole(viewer);
  const groups = FRONT_DESK_MENU.map((item) => ({
    id: item.id,
    label: catalogT(item.label_key as VocabularyKey, undefined, locale),
  }));
  return {
    role,
    groups,
    components: listUiComponents(role).map((component) => ({
      id: component.id,
      kind: component.kind,
      status: component.status,
      title: catalogT(component.title_key as VocabularyKey, undefined, locale),
      summary: catalogT(component.summary_key as VocabularyKey, undefined, locale),
      group: component.menu.group,
      order: component.menu.order,
      host: component.host,
      href: componentHref(component),
      ...(component.entry?.a2ui_path ? { a2ui_path: component.entry.a2ui_path } : {}),
      ...(component.entry?.input
        ? {
            input: {
              operation_id: component.entry.input.operation_id,
              placeholder: catalogT(
                component.entry.input.placeholder_key as VocabularyKey,
                undefined,
                locale
              ),
            },
          }
        : {}),
      operations: component.operations,
    })),
  };
}

function requirementLabel(
  item: { label_key: string; label_source?: 'vocabulary' | 'tenant'; label_text?: string },
  locale: SupportedLocale
): string {
  return item.label_source === 'tenant' && item.label_text
    ? item.label_text
    : catalogT(item.label_key as VocabularyKey, undefined, locale);
}

/** The hearing flow projected for the host: A2UI messages + actions + the input operation. */
export function projectHearingFlow(
  record: HearingRecord & { mission_id?: string },
  sessionId: string,
  locale: SupportedLocale
) {
  const labels = Object.fromEntries(
    record.requirements.map((item) => [item.id, requirementLabel(item, locale)])
  );
  const progress = hearingPhaseProgress(record.requirements, record.phases ?? []);
  const phases = record.phases?.length
    ? progress.phases.map((phase) => ({
        id: phase.id,
        title: catalogT(phase.title_key as VocabularyKey, undefined, locale),
        complete: phase.complete,
        total: phase.total,
      }))
    : [];
  const next = nextHearingQuestion(record);
  const currentPhase = phases.find((phase) => phase.complete < phase.total);
  const prompt = next
    ? currentPhase
      ? catalogT(
          'front_desk:hearing_next_question_in_phase',
          { phase: currentPhase.title, label: labels[next.id] },
          locale
        )
      : catalogT('front_desk:hearing_next_question', { label: labels[next.id] }, locale)
    : catalogT('front_desk:hearing_all_answered', undefined, locale);
  const answered = record.requirements.filter((item) => item.answer?.trim()).length;
  const projection = buildHearingA2UI({
    record,
    sessionId,
    labels,
    phases,
    prompt,
    nextRequirementId: next?.id,
    missionId: record.mission_id,
    text: {
      title: catalogT('front_desk:component_hearing_title', undefined, locale),
      coverage: catalogT(
        'front_desk:hearing_coverage',
        { done: answered, total: record.requirements.length },
        locale
      ),
      next_question: catalogT('front_desk:hearing_a2ui_next', undefined, locale),
      unanswered: catalogT('front_desk:hearing_canvas_unanswered', undefined, locale),
      decide: catalogT('front_desk:hearing_decide', undefined, locale),
      handoff: catalogT('front_desk:hearing_handoff_button', undefined, locale),
      phases: catalogT('front_desk:flow_phases', undefined, locale),
      ...(record.decided_at
        ? {
            recorded: catalogT(
              'front_desk:hearing_a2ui_recorded',
              { at: record.decided_at.slice(0, 16).replace('T', ' ') },
              locale
            ),
          }
        : {}),
      ...(record.mission_id
        ? {
            handed_off: catalogT(
              'front_desk:hearing_a2ui_handed_off',
              { id: record.mission_id },
              locale
            ),
          }
        : {}),
    },
  });
  return {
    // Same envelope shape as the other A2UI projections (`a2ui` message list).
    a2ui: projection.messages,
    actions: projection.actions,
    input:
      record.decided_at || !next
        ? null
        : {
            operation_id: 'presence.hearing.answer',
            method: 'POST' as const,
            path: `/api/hearing/${encodeURIComponent(sessionId)}/answer`,
            body_field: 'text',
            body: { locale },
            refresh: true,
          },
  };
}

export function registerComponentHostRoutes(app: express.Express, staticDir: string): void {
  app.get('/flow/:component', presenceStudioAuthRateLimiter, (req, res) => {
    const id = String(req.params.component || '').trim();
    if (!COMPONENT_ID_PATTERN.test(id)) {
      res.status(404).end();
      return;
    }
    res.sendFile(path.join(staticDir, 'flow.html'));
  });

  app.get('/api/flow-vocabulary', presenceStudioAuthRateLimiter, (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      locale,
      texts: Object.fromEntries(
        FLOW_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
      ),
    });
  });

  app.get('/api/components', presenceStudioAuthRateLimiter, (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      authorizePresenceOperation(viewer, 'presence.components.read');
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        generated_at: nowIso(),
        ...describeComponentsForViewer(viewer, locale),
      });
    } catch (error) {
      respondError(req, res, error);
    }
  });

  app.get('/api/headless/a2ui/hearing', presenceStudioAuthRateLimiter, (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      authorizePresenceOperation(viewer, 'presence.hearing.view.a2ui');
      const sessionId = String(readSurfaceStringParam(req.query.session) || '').trim();
      if (!HEARING_SAFE_ID_PATTERN.test(sessionId)) {
        throw new ComponentHostRequestError('A hearing session id is required.');
      }
      const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
      const namespace = hearingNamespace(viewer.tenantSlugs);
      const record =
        loadHearingRecord(namespace, sessionId) ||
        defaultHearingRecord(sessionId, nowIso(), defaultCatalogScenario());
      res.setHeader('Cache-Control', 'no-store');
      res.json(
        presenceEnvelope(
          'hearing',
          { source_resource: 'hearing', ...projectHearingFlow(record, sessionId, locale) },
          viewer
        )
      );
    } catch (error) {
      respondError(req, res, error);
    }
  });
}
