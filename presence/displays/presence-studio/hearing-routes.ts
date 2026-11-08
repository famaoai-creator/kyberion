// HT-01/03/04: hearing session routes, split into their own module the same
// way `front-desk-routes.ts` was split out of `server.ts` — registered from
// `server.ts` at the position these routes were dropped from during the
// front-desk route/page split (see
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2/§2.3). `registerHearingRoutes` is called once, after the same
// `/api` + `/a2ui` guard and rate limiter every other API route runs behind.
import type express from 'express';
import type { Request, Response } from 'express';
import { logger } from '@agent/core/core';
import {
  answerHearing,
  decideHearing,
  defaultCatalogScenario,
  hearingErrorExtras,
  hearingSessionErrorStatus,
  readHearingCanvas,
  readHearingDecisionReceipt,
  readHearingSession,
  saveHearingInventory,
  type HearingRecordWithInventoryFields,
} from '@agent/core/surface/hearing-session-service';
import type { HearingWorkInventoryHandoffFields } from '@agent/core/surface/hearing-completion';
import { requirePresenceStudioLocalAdmin } from './security.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';
import { resolveHearingRequestViewer } from './hearing-request-scope.js';
import {
  presenceStudioHearingContext,
  presenceStudioViewerErrorStatus,
  sendHearingResult,
} from './hearing-route-context.js';

// The route steps themselves are shared with Concierge in
// `libs/core/surface/hearing-session-service.ts`; this file keeps Studio's
// gate (viewer, then the local-admin check on every write and on receipts)
// and its error/audit format.

/** WI-08: additive fields this route owns on the hearing record — declared next
 * to the completion reader in core (`libs/core/surface/hearing-completion.ts`),
 * only ever read/written here, never added to the base interface. */
export type { HearingWorkInventoryHandoffFields, HearingRecordWithInventoryFields };

export { defaultCatalogScenario };

function hearingResponseError(req: Request, res: Response, error: unknown): void {
  const status = hearingSessionErrorStatus(error, presenceStudioViewerErrorStatus);
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json({
    ...presenceStudioData.presenceStudioWireError(error, status),
    ...hearingErrorExtras(error),
  });
}

export function registerHearingRoutes(app: express.Express): void {
  // HT-01: read-only hearing record and deterministic fixed canvas. A missing
  // record is returned as an in-memory default and persisted after the first
  // answer mutation.
  app.get('/api/hearing/:session/canvas', async (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      const ctx = presenceStudioHearingContext(req, viewer);
      await sendHearingResult(res, readHearingCanvas(ctx, req.params.session, req.query));
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // HT-06: `?locale=` mirrors the locale the page already sends to
  // `/api/ask-vocabulary` — every requirement's `label_key` is resolved to
  // that locale's text server-side without touching the persisted
  // `label_key`, so a later locale change re-renders.
  app.get('/api/hearing/:session', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      const ctx = presenceStudioHearingContext(req, viewer);
      sendHearingResult(res, readHearingSession(ctx, req.params.session, req.query));
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  app.post('/api/hearing/:session/answer', async (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const ctx = presenceStudioHearingContext(req, viewer);
      await sendHearingResult(res, answerHearing(ctx, req.params.session, req.body, req.query));
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // HT-03 / FD-10 item 4: record the human decision (never creates mission state).
  app.post('/api/hearing/:session/decide', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const ctx = presenceStudioHearingContext(req, viewer);
      sendHearingResult(res, decideHearing(ctx, req.params.session, req.body, req.query));
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // Read-only exact receipt proof. Absence is unknown, never evidence of non-execution.
  app.get('/api/hearing/:session/decision-receipts/:operation', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const ctx = presenceStudioHearingContext(req, viewer);
      sendHearingResult(
        res,
        readHearingDecisionReceipt(ctx, req.params.session, req.params.operation, req.query)
      );
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });

  // WI-08: confirm-and-save a decided `work_inventory` hearing record as a
  // work-inventory entry. Localadmin only, same posture as `/decide` and the
  // mission `/handoff` route; idempotent per session.
  app.post('/api/hearing/:session/inventory', async (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const ctx = presenceStudioHearingContext(req, viewer);
      await sendHearingResult(
        res,
        saveHearingInventory(ctx, req.params.session, req.body, req.query)
      );
    } catch (error) {
      hearingResponseError(req, res, error);
    }
  });
}
