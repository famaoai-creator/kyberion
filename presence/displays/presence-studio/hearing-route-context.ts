// Presence Studio's adapter onto the shared hearing operations
// (`@agent/core/surface/hearing-session-service`, `-mission-service`,
// `-ledger-service`). The operations are framework neutral; this file binds
// them to Studio's viewer, its owner rule (the credential-free loopback
// session — every such request is localadmin here), its refusal error, its
// audit line format, its decision-ledger reads and its express response.
import type { Request, Response } from 'express';
import { logger } from '@agent/core/core';
import {
  renderLedgerCanvasForRecord,
  resolveLedgerScenarioRef,
  type HearingRouteContext,
  type HearingRouteResult,
} from '@agent/core/surface/hearing-session-service';
import {
  PresenceStudioViewerError,
  presenceStudioRecordInScope,
  type PresenceStudioViewerContext,
} from './security.js';
import { hearingStorageForViewer } from './hearing-storage-access.js';
import { hearingViewerScope, resolveHearingHandoffScope } from './hearing-request-scope.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

/** The shared hearing context for one Studio request and its resolved viewer. */
export function presenceStudioHearingContext(
  req: Request,
  viewer: PresenceStudioViewerContext
): HearingRouteContext {
  return {
    viewer: hearingViewerScope(viewer),
    owner: viewer.source === 'loopback',
    currentSurface: 'presence-studio',
    storage: () => hearingStorageForViewer(viewer),
    handoffScope: (kind) => resolveHearingHandoffScope(viewer, kind),
    denied: (status, message) => new PresenceStudioViewerError(status, message),
    audit: (level, action, fields) =>
      logger[level](presenceStudioData.presenceStudioAuditLine(req, action, fields)),
    recordInScope: (record) => presenceStudioRecordInScope(viewer, record),
    // presence_studio may assume decision_ledger (role-assumption-policy.json).
    ledger: { scenarioRef: resolveLedgerScenarioRef, canvas: renderLedgerCanvasForRecord },
  };
}

/** Status of Studio's own viewer refusal, if `error` is one. */
export function presenceStudioViewerErrorStatus(error: unknown): number | undefined {
  return error instanceof PresenceStudioViewerError ? error.status : undefined;
}

/** Write one shared hearing result to the express response. A synchronous
 * result is written synchronously (as the routes did before the move). */
export function sendHearingResult(
  res: Response,
  result: HearingRouteResult | Promise<HearingRouteResult>
): void | Promise<void> {
  if (result instanceof Promise) return result.then((value) => sendHearingResult(res, value));
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  if (result.kind === 'html') {
    res.type('html');
    res.send(result.html);
    return;
  }
  res.status(result.status).json(result.body);
  result.after?.();
}
