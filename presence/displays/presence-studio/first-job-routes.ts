import {
  readFirstJobRecoveries,
  terminateFirstJobRequest,
} from '@agent/core/surface/first-job-recovery';
import { normalizeLocale } from '@agent/core/locale-normalize';
import { readFirstJobSetup } from '@agent/core/surface/first-job-setup';
/** Local-only typed diagnostic intake; outer authentication and rate limits remain installed. */
import type express from 'express';
import {
  parseFirstJobRequest,
  parseFirstJobReadRequest,
  parseFirstJobArtifactReadRequest,
  parseFirstJobApprovalDecisionRequest,
  parseFirstJobRecoveryRequest,
} from '@agent/core/surface/first-job-contract';
import {
  FIRST_JOB_NEXT_ACTION,
  readFirstJobSnapshot,
  readFirstJobArtifact,
  resolveFirstJobViewer,
} from '@agent/core/surface/first-job';
import {
  FRONT_DESK_RECEIPT_COMMAND,
  frontDeskArtifactRevisionCommand,
} from '@agent/core/surface/front-desk-execution-contract';
import {
  conversationRef,
  reserveConversationTurn,
  completeConversationTurn,
  ConversationStoreError,
} from '@agent/core/surface/front-desk-conversation-store';
import {
  isSameOriginMutation,
  extractSurfaceCredential,
} from '@agent/core/surface/surface-session-cookie';
import {
  readFirstJobApprovals,
  decideFirstJobApproval,
  FirstJobApprovalError,
} from '@agent/core/surface/first-job-approval';
import {
  isLoopbackAddress,
  resolvePresenceStudioViewerContext,
  requirePresenceStudioLocalAdmin,
  toFrontDeskViewerScope,
  PresenceStudioViewerError,
} from './security.js';

function viewerFor(req: express.Request) {
  // Forwarded addresses and caller-provided scope headers cannot establish locality.
  if (!isLoopbackAddress(String(req.socket?.remoteAddress || '')))
    throw new PresenceStudioViewerError(403, 'first_job_local_session_required');
  if (!localRequestOrigin(req))
    throw new PresenceStudioViewerError(403, 'first_job_local_host_required');
  const viewer = resolvePresenceStudioViewerContext(req);
  requirePresenceStudioLocalAdmin(viewer);
  // Deliberately before the generic Presence-to-Concierge identity alias.
  return toFrontDeskViewerScope(viewer);
}
/** Pin local host as well as socket, including read-only requests (DNS rebinding). */
function localRequestOrigin(req: express.Request): string | undefined {
  if (typeof req.headers.host !== 'string') return undefined;
  try {
    const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted
      ? 'https:'
      : 'http:';
    const expected = new URL(protocol + '//' + req.headers.host);
    const host = expected.hostname.replace(/^\[|\]$/g, '');
    if (
      expected.username ||
      expected.password ||
      !(host === 'localhost' || isLoopbackAddress(host))
    )
      return undefined;
    return expected.origin;
  } catch {
    return undefined;
  }
}
function sameOrigin(req: express.Request): boolean {
  if (
    !isSameOriginMutation({
      method: 'POST',
      headers: req.headers,
      expectedHost: String(req.headers.host || ''),
    })
  )
    return false;
  const source = req.headers.origin || req.headers.referer;
  if (typeof source !== 'string') return false;
  try {
    return new URL(source).origin === localRequestOrigin(req);
  } catch {
    return false;
  }
}

function failure(res: express.Response, status: number, error: string, retrySafe: boolean) {
  return res
    .status(status)
    .json({ ok: false, error, retry_safe: retrySafe, next_action: FIRST_JOB_NEXT_ACTION });
}
export function registerFirstJobRoutes(app: express.Express): void {
  const credentialFor = (req: express.Request) =>
    extractSurfaceCredential({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    }).token;
  app.get('/api/first-job/approvals', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const viewer = viewerFor(req);
      const input = parseFirstJobReadRequest(req.query);
      if (!input || (input.locale !== undefined && !normalizeLocale(input.locale)))
        return failure(res, 400, 'first_job_invalid_request', true);
      const approvals = readFirstJobApprovals(viewer, credentialFor(req), input);
      const recovery_requests =
        approvals.auth.status === 'ready' && approvals.readiness.ready
          ? readFirstJobRecoveries(viewer, credentialFor(req), input)
          : [];
      return res.json({
        ...approvals,
        recovery_requests,
        held_requests: approvals.held_requests.filter(
          (held) => !recovery_requests.some((row) => row.request_id === held.request_id)
        ),
      });
    } catch (error) {
      return failure(
        res,
        error instanceof PresenceStudioViewerError ? error.status : 503,
        error instanceof PresenceStudioViewerError
          ? 'first_job_access_denied'
          : 'first_job_approvals_unavailable',
        true
      );
    }
  });
  app.post('/api/first-job/approvals/:requestId/decision', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const viewer = viewerFor(req);
      if (!sameOrigin(req)) return failure(res, 403, 'first_job_origin_denied', true);
      const input = parseFirstJobApprovalDecisionRequest(req.body);
      if (!input || Object.keys(req.query).length !== 0 || typeof req.params.requestId !== 'string')
        return failure(res, 400, 'first_job_invalid_request', true);
      const result = decideFirstJobApproval(
        viewer,
        credentialFor(req),
        req.params.requestId,
        input
      );
      return res.json({ ok: true, approval_request_id: result.id, status: result.status });
    } catch (error) {
      if (error instanceof FirstJobApprovalError)
        return failure(res, error.status, error.message, error.status !== 503);
      if (error instanceof PresenceStudioViewerError)
        return failure(res, error.status, 'first_job_access_denied', true);
      return failure(res, 503, 'first_job_decision_uncertain', false);
    }
  });

  app.post('/api/first-job/recovery/:requestId', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const viewer = viewerFor(req);
      if (!sameOrigin(req)) return failure(res, 403, 'first_job_origin_denied', true);
      const input = parseFirstJobRecoveryRequest(req.body);
      if (!input || Object.keys(req.query).length !== 0 || typeof req.params.requestId !== 'string')
        return failure(res, 400, 'first_job_invalid_request', true);
      return res.json(
        terminateFirstJobRequest(viewer, credentialFor(req), req.params.requestId, input)
      );
    } catch (error) {
      if (error instanceof FirstJobApprovalError)
        return failure(res, error.status, error.message, false);
      if (error instanceof PresenceStudioViewerError)
        return failure(res, error.status, 'first_job_access_denied', false);
      return failure(res, 503, 'first_job_recovery_uncertain', false);
    }
  });

  app.get('/api/first-job/artifact', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const viewer = viewerFor(req);
      const input = parseFirstJobArtifactReadRequest(req.query);
      if (!input) return failure(res, 400, 'first_job_invalid_request', true);
      const result = readFirstJobArtifact(viewer, input);
      return result ? res.json(result) : failure(res, 404, 'first_job_artifact_unavailable', true);
    } catch (error) {
      return failure(
        res,
        error instanceof PresenceStudioViewerError ? error.status : 503,
        error instanceof PresenceStudioViewerError
          ? 'first_job_access_denied'
          : 'first_job_artifact_unavailable',
        true
      );
    }
  });

  app.get('/api/first-job', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const viewer = viewerFor(req);
      const input = parseFirstJobReadRequest(req.query);
      if (!input || (input.locale !== undefined && !normalizeLocale(input.locale)))
        return failure(res, 400, 'first_job_invalid_request', true);
      const snapshot = readFirstJobSnapshot(viewer, input);
      return res.json({
        ...snapshot,
        setup: readFirstJobSetup(viewer, credentialFor(req), snapshot),
      });
    } catch (error) {
      return failure(
        res,
        error instanceof PresenceStudioViewerError ? error.status : 503,
        error instanceof PresenceStudioViewerError
          ? 'first_job_access_denied'
          : 'first_job_history_unavailable',
        true
      );
    }
  });
  app.post('/api/first-job', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let reserved = false;
    try {
      const authenticated = viewerFor(req);
      // Loopback authentication has an early return in the outer guard, so this
      // mutation explicitly checks browser origin even if a bearer header exists.
      if (!sameOrigin(req)) return failure(res, 403, 'first_job_origin_denied', true);
      const input = parseFirstJobRequest(req.body);
      if (
        !input ||
        (input.locale !== undefined && !normalizeLocale(input.locale)) ||
        Object.keys(req.query).length !== 0
      )
        return failure(res, 400, 'first_job_invalid_request', true);
      const resolution = resolveFirstJobViewer(authenticated);
      if (resolution.ready === false)
        return failure(res, 409, 'first_job_' + resolution.status, true);
      const viewer = resolution.viewer;
      const ref = conversationRef(viewer);
      if (input.session_id && input.session_id !== ref.sessionId)
        return failure(res, 409, 'first_job_scope_changed', true);
      const revision = input.action === 'revise' ? input.artifactRevision : undefined;
      const command = revision
        ? frontDeskArtifactRevisionCommand(revision.format)
        : FRONT_DESK_RECEIPT_COMMAND;
      const turn = reserveConversationTurn(
        viewer,
        command,
        input.request_id,
        undefined,
        normalizeLocale(input.locale) ?? undefined,
        revision,
        { requireDiagnosticAdmission: true }
      );
      reserved = true;
      // The strict store contract provides an atomic diagnostic outbox and inert
      // acknowledgement. There is intentionally no conversation-runtime fallback.
      const reply = turn.routing?.reply;
      if (!reply) return failure(res, 503, 'first_job_admission_uncertain', false);
      if (turn.created) completeConversationTurn(viewer, turn.id, reply);
      const snapshot = readFirstJobSnapshot(authenticated, {
        session_id: ref.sessionId,
        locale: input.locale,
      });
      return res.json({
        ...snapshot,
        setup: readFirstJobSetup(authenticated, credentialFor(req), snapshot),
        request_id: input.request_id,
        replayed: !turn.created,
        mode: turn.created ? 'intake' : 'history',
        historySaved: true,
      });
    } catch (error) {
      if (error instanceof PresenceStudioViewerError)
        return failure(res, error.status, 'first_job_access_denied', true);
      if (error instanceof ConversationStoreError) {
        const invalid = ['invalid_revision', 'invalid_text'].includes(error.code);
        const unavailable = error.code === 'invalid_history';
        return failure(
          res,
          invalid ? 400 : unavailable ? 503 : 409,
          'first_job_' + error.code,
          !reserved && !unavailable
        );
      }
      return failure(res, 503, 'first_job_admission_uncertain', false);
    }
  });
}
