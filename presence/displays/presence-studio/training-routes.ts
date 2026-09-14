// HT-04/05: training-catalog routes, split into their own module the same
// way `front-desk-routes.ts` was split out of `server.ts` — registered from
// `server.ts` at the position these routes were dropped from during the
// front-desk route/page split (see
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2/§2.3). `registerTrainingRoutes` is called once, after the same
// `/api` + `/a2ui` guard and rate limiter every other API route runs behind.
import type express from 'express';
import { nowIso } from '@agent/core/foundation';
import { withExecutionContext } from '@agent/core/authority';
import { resolveMemberByPrincipal } from '@agent/core/member-registry';
import {
  loadTrainingCatalog,
  readTrainingAssignments,
  readTrainingProgress,
  upsertTrainingAssignment,
  writeTrainingProgress,
  type TrainingStatus,
} from '@agent/core/training-catalog';
import {
  PresenceStudioViewerError,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
} from './security.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

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
}
