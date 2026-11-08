// HT-03 (2nd half): hand a decided hearing record off to the governed
// mission/alignment pipeline. See
// docs/developer/improvement-plans-2026-08/FRONT_DESK_HEARING_TRAINING_PLAN_2026-09-14.ja.md
// §2.2 / HT-03 and FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md §2.5.
//
// The hand-off steps (mission controller and alignment request as built
// subprocesses, never `scripts/**` imports) are shared with Concierge in
// `libs/core/surface/hearing-mission-service.ts`; this file keeps Studio's
// gate (viewer, then the local-admin check) and its error/audit format.
//
// Registered right after `registerHearingRoutes` in `server.ts` (same guard
// position — behind the shared `/api`/`/a2ui` guard + rate limiter every
// other API route runs behind).
import type express from 'express';
import type { Request, Response } from 'express';
import { logger } from '@agent/core/core';
import {
  handOffHearingToMission,
  hearingErrorExtras,
  hearingMissionErrorStatus,
  type HearingRecordWithMissionHandoff,
} from '@agent/core/surface/hearing-session-service';
import type { HearingMissionHandoffFields } from '@agent/core/surface/hearing-completion';
import { requirePresenceStudioLocalAdmin } from './security.js';
import { resolveHearingRequestViewer } from './hearing-request-scope.js';
import {
  presenceStudioHearingContext,
  presenceStudioViewerErrorStatus,
  sendHearingResult,
} from './hearing-route-context.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

/** Additive fields this route owns on the hearing record — declared next to the
 * completion reader in core (`libs/core/surface/hearing-completion.ts`), only
 * ever read/written via an intersection type, never on the base interface. */
export type { HearingMissionHandoffFields, HearingRecordWithMissionHandoff };

function hearingMissionResponseError(req: Request, res: Response, error: unknown): void {
  const status = hearingMissionErrorStatus(error, presenceStudioViewerErrorStatus);
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.handoff.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json({
    ...presenceStudioData.presenceStudioWireError(error, status),
    ...hearingErrorExtras(error),
  });
}

export function registerHearingMissionRoutes(app: express.Express): void {
  // HT-03 (2nd half): confirm-and-hand-off. Localadmin only (a held-action
  // mutation, same posture as `/decide`).
  app.post('/api/hearing/:session/handoff', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const ctx = presenceStudioHearingContext(req, viewer);
      sendHearingResult(res, handOffHearingToMission(ctx, req.params.session, req.body, req.query));
    } catch (error) {
      hearingMissionResponseError(req, res, error);
    }
  });
}
