// HT-04/05: training-catalog routes, split into their own module the same
// way `front-desk-routes.ts` was split out of `server.ts` — registered from
// `server.ts` at the position these routes were dropped from during the
// front-desk route/page split (see
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2/§2.3). `registerTrainingRoutes` is called once, after the same
// `/api` + `/a2ui` guard and rate limiter every other API route runs behind.
import type express from 'express';
import { nowIso } from '@agent/core/foundation';
import { t as catalogT } from '@agent/core/t';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { readSurfaceStringParam } from '@agent/core/surface-request-input';
import { withExecutionContext } from '@agent/core/authority';
import {
  listMemberIds,
  readMemberProfile,
  resolveMemberByPrincipal,
  type MemberProfile,
} from '@agent/core/member-registry';
import { listTenantProfileSlugs } from '@agent/core/tenant-registry';
import { frontDeskRoleFromViewerScope, type FrontDeskRole } from '@agent/core/front-desk-identity';
import {
  loadTrainingCatalog,
  readTrainingAssignments,
  readTrainingProgress,
  summarizeTrainingProgress,
  upsertTrainingAssignment,
  writeTrainingProgress,
  type TrainingStatus,
} from '@agent/core/training-catalog';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
  toFrontDeskViewerScope,
  type PresenceStudioViewerContext,
} from './security.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

// HT-04/05 second pass: exactly the `front_desk` keys `static/help.js`'s
// "mark this lesson done" button renders. `HELP_VOCABULARY_KEYS` in
// `front-desk-pages.ts` is frozen for this wave (owned by the hearing/help
// route split), so this wave's new copy is served through its own
// `/api/training/vocabulary` mirroring `/api/help-vocabulary`'s shape
// instead of extending that frozen list.
export const TRAINING_VOCABULARY_KEYS = [
  'front_desk:training_mark_done',
  'front_desk:training_mark_done_recorded',
  'front_desk:training_mark_done_failed',
] as const;

/** Same posture as `hearing-routes.ts`'s `resolveHearingDeciderRole`: a
 * resolved member's own per-tenant membership role wins over the viewer
 * scope's blanket role, so a loopback session that is not actually the
 * tenant owner cannot read every member's training progress. */
function resolveTrainingViewerRole(
  member: Pick<MemberProfile, 'memberships'>,
  viewer: PresenceStudioViewerContext
): FrontDeskRole {
  const tenant = viewer.tenantSlugs !== 'all' ? viewer.tenantSlugs[0] : undefined;
  const membership = tenant
    ? member.memberships.find((item) => item.tenant_slug === tenant)
    : undefined;
  if (membership) return membership.role;
  return frontDeskRoleFromViewerScope(toFrontDeskViewerScope(viewer));
}

export function registerTrainingRoutes(app: express.Express): void {
  // HT-04: help reads the governed catalog; progress is keyed by the
  // server-resolved member and never by a client-supplied member id.
  app.get('/api/training/catalog', (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, catalog: loadTrainingCatalog() });
    } catch (error) {
      res.status(500).json(presenceStudioData.presenceStudioWireError(error, 500));
    }
  });

  app.get('/api/training/progress', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const member = withExecutionContext('ecosystem_architect', () =>
        resolveMemberByPrincipal({ principalId: viewer.principalId, source: viewer.source })
      );
      if (!member) return res.status(404).json({ ok: false, error: 'Training member not found.' });
      const progress = withExecutionContext('ecosystem_architect', () =>
        readTrainingProgress(member.member_id)
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, progress });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  app.post('/api/training/progress', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
      const member = withExecutionContext('ecosystem_architect', () =>
        resolveMemberByPrincipal({ principalId: viewer.principalId, source: viewer.source })
      );
      if (!member) return res.status(404).json({ ok: false, error: 'Training member not found.' });
      const lessonId = typeof req.body?.lesson_id === 'string' ? req.body.lesson_id.trim() : '';
      const status = req.body?.status as TrainingStatus;
      const lesson = loadTrainingCatalog()
        .tracks.flatMap((track) => track.lessons)
        .find((item) => item.id === lessonId);
      if (!lesson || !['not_started', 'in_progress', 'complete'].includes(status)) {
        return res.status(400).json({ ok: false, error: 'Invalid training progress.' });
      }
      const current = withExecutionContext('ecosystem_architect', () =>
        readTrainingProgress(member.member_id)
      );
      const progress = withExecutionContext('ecosystem_architect', () =>
        writeTrainingProgress({
          ...current,
          lessons: {
            ...current.lessons,
            [lessonId]: { status, ...(status === 'complete' ? { completed_at: nowIso() } : {}) },
          },
        })
      );
      return res.json({ ok: true, progress });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  app.get('/api/training/assignments', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      const tenant = viewer.tenantSlugs === 'all' ? '' : viewer.tenantSlugs[0];
      if (!tenant) return res.status(400).json({ ok: false, error: 'Tenant scope is required.' });
      return res.json({ ok: true, assignments: readTrainingAssignments(tenant) });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  app.post('/api/training/assignments', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
      const tenant = viewer.tenantSlugs === 'all' ? '' : viewer.tenantSlugs[0];
      const memberId = typeof req.body?.member_id === 'string' ? req.body.member_id.trim() : '';
      const trackId = typeof req.body?.track_id === 'string' ? req.body.track_id.trim() : '';
      if (!tenant || !memberId || !trackId)
        return res.status(400).json({ ok: false, error: 'member_id and track_id are required.' });
      return res.json({
        ok: true,
        assignments: upsertTrainingAssignment(tenant, memberId, trackId),
      });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 400;
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // HT-05 second pass: per-member training standing for the owner. Loopback
  // only (`requirePresenceStudioLocalAdmin`) and, on top of that, the
  // server-resolved member's own role for the viewing tenant must be
  // `owner` — a non-owner local session and every token viewer both get
  // 403. Tenant-narrowed via the server-resolved `viewer.tenantSlugs`,
  // never a client-supplied member id or tenant.
  app.get('/api/training/progress/overview', (req, res) => {
    try {
      const viewer = resolvePresenceStudioViewerContext(req);
      requirePresenceStudioLocalAdmin(viewer);
      const member = withExecutionContext('ecosystem_architect', () =>
        resolveMemberByPrincipal({ principalId: viewer.principalId, source: viewer.source })
      );
      if (!member) return res.status(404).json({ ok: false, error: 'Training member not found.' });
      if (resolveTrainingViewerRole(member, viewer) !== 'owner') {
        return res
          .status(403)
          .json({ ok: false, error: 'Training progress overview requires the owner role.' });
      }
      const overview = withExecutionContext('ecosystem_architect', () => {
        const tenants =
          viewer.tenantSlugs === 'all' ? listTenantProfileSlugs() : viewer.tenantSlugs;
        const catalog = loadTrainingCatalog();
        const members = listMemberIds()
          .map((memberId) => readMemberProfile(memberId))
          .filter((profile): profile is MemberProfile => Boolean(profile))
          .filter((profile) =>
            profile.memberships.some((membership) => tenants.includes(membership.tenant_slug))
          );
        const assignments = tenants.flatMap(
          (tenant) => readTrainingAssignments(tenant).assignments
        );
        const progressByMember = Object.fromEntries(
          members.map((profile) => [profile.member_id, readTrainingProgress(profile.member_id)])
        );
        const summaries = summarizeTrainingProgress(catalog, assignments, progressByMember);
        const displayNameById = new Map(
          members.map((profile) => [profile.member_id, profile.display_name])
        );
        return summaries.map((summary) => ({
          ...summary,
          display_name: displayNameById.get(summary.member_id) ?? summary.member_id,
        }));
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, overview });
    } catch (error) {
      const status = error instanceof PresenceStudioViewerError ? error.status : 500;
      return res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
    }
  });

  // HT-04/05 second pass: exactly the keys `static/help.js`'s "mark done"
  // button renders — mirrors `/api/help-vocabulary` in
  // `front-desk-routes.ts` (same read-only, viewer-scoped, no
  // client-supplied widening shape), scoped to this wave's new copy since
  // `HELP_VOCABULARY_KEYS` is frozen.
  app.get('/api/training/vocabulary', (req, res) => {
    const locale = normalizeLocale(readSurfaceStringParam(req.query.locale)) ?? 'en';
    const texts = Object.fromEntries(
      TRAINING_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, locale, texts });
  });
}
