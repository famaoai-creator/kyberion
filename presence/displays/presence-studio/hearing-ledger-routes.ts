// SD-02 / SD-03 / SD-04: the hearing surface as the entrance of the decision
// ledger (SSOD = Single Source of Decisions). See
// docs/developer/improvement-plans-2026-09/SSOD_HEARING_INTEGRATION_PLAN_2026-09-14.ja.md
// §1.3 (requirement id = decision id) and §2.2 (level × actor).
//
// Two seams:
//   GET  /api/hearing/decisions/agenda?case=<id>&actor=product|customer
//        → `pnpm decisions ask` rendered as a hearing scenario the /ask page opens with
//   POST /api/hearing/:session/record-decisions
//        → answered requirements become promotion requests; the ledger write goes
//          through the governed facade `dist/scripts/decisions.js import` as a built
//          subprocess (never a library import of `scripts/**`, same boundary as
//          `hearing-mission-routes.ts`). Product levels decided by an owner/approver
//          land as `decided`; a customer's value lands as `proposed` until its
//          approval evidence is recorded (`on_behalf_of.evidence`), and the
//          response names who to ask. A greenfield hearing (`web_app_build`)
//          becomes a product concept (`PC-*`) in the same ledger.
//
// The steps are shared with Concierge in
// `libs/core/surface/hearing-ledger-service.ts` (ledger reads run under
// `decision_ledger`; the tenant is the viewer's server-side namespace, never a
// request parameter); this file keeps Studio's gate and error/audit format.
import type express from 'express';
import type { Request, Response } from 'express';
import { logger } from '@agent/core/core';
import {
  buildLedgerImportLines,
  hearingLedgerErrorStatus,
  HearingLedgerRequestError,
  readHearingLedgerAgenda,
  recordHearingDecisions,
  renderLedgerCanvasForRecord,
  resolveLedgerScenarioRef,
  type HearingLedgerFields,
  type HearingRecordWithLedger,
} from '@agent/core/surface/hearing-session-service';
import { requirePresenceStudioLocalAdmin } from './security.js';
import { resolveHearingRequestViewer } from './hearing-request-scope.js';
import {
  presenceStudioHearingContext,
  presenceStudioViewerErrorStatus,
  sendHearingResult,
} from './hearing-route-context.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

export {
  buildLedgerImportLines,
  HearingLedgerRequestError,
  renderLedgerCanvasForRecord,
  resolveLedgerScenarioRef,
};
export type { HearingLedgerFields, HearingRecordWithLedger };

function respondError(req: Request, res: Response, error: unknown): void {
  const status = hearingLedgerErrorStatus(error, presenceStudioViewerErrorStatus);
  logger.warn(
    presenceStudioData.presenceStudioAuditLine(req, 'hearing.ledger.reject', {
      status,
      error: error instanceof Error ? error.message : String(error),
    })
  );
  res.status(status).json(presenceStudioData.presenceStudioWireError(error, status));
}

export function registerHearingLedgerRoutes(app: express.Express): void {
  app.get('/api/hearing/decisions/agenda', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      sendHearingResult(
        res,
        readHearingLedgerAgenda(presenceStudioHearingContext(req, viewer), req.query)
      );
    } catch (error) {
      respondError(req, res, error);
    }
  });

  app.post('/api/hearing/:session/record-decisions', (req, res) => {
    try {
      const viewer = resolveHearingRequestViewer(req);
      requirePresenceStudioLocalAdmin(viewer);
      const ctx = presenceStudioHearingContext(req, viewer);
      sendHearingResult(res, recordHearingDecisions(ctx, req.params.session, req.body, req.query));
    } catch (error) {
      respondError(req, res, error);
    }
  });
}
