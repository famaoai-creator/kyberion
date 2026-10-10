// Approval inbox routes, split out of `server.ts` the same way the hearing and
// front-desk routes were. Registered after the shared `/api` guard and rate
// limiter; the decision route also carries the `express-rate-limit` limiter
// used for credential-reading routes.
import type express from 'express';
import { logger } from '@agent/core/core';
import {
  decideApprovalRequest,
  listApprovalRequests,
  surfaceDecisionAuthMethod,
  surfaceDecisionBinding,
} from '@agent/core/governance/approval-store';
import { presenceStudioApprovalDecisionSchema, readPresenceStudioStringParam } from './security.js';
import { presenceStudioAuthRateLimiter } from './surface-auth.js';
import * as presenceStudioData from './presence-studio-runtime-data.js';

export type LoopbackDecisionActorResolver = (
  recordTenant?: string
) => { actorId: string; role: 'owner' | 'approver' } | null;

export function registerApprovalInboxRoutes(
  app: express.Express,
  resolveLoopbackDecisionActor: LoopbackDecisionActorResolver
): void {
  app.get('/api/approvals', (_req, res) => {
    res.json({
      ok: true,
      items: listApprovalRequests({ status: 'pending' })
        .slice(0, 10)
        .map(presenceStudioData.buildApprovalInboxItem),
    });
  });

  app.post('/api/approvals/:requestId/decision', presenceStudioAuthRateLimiter, (req, res) => {
    const requestId = readPresenceStudioStringParam(req.params.requestId);
    const parsed = presenceStudioApprovalDecisionSchema.safeParse(
      presenceStudioData.safeParsePresenceStudioRequestBody(req.body, 'approval decision body')
    );
    if (!requestId) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
          status: 400,
          error: 'requestId is required',
        })
      );
      return res.status(400).json({ ok: false, error: 'requestId is required' });
    }
    if (!parsed.success) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
          request_id: requestId,
          status: 400,
          error: 'decision must be approved or rejected',
        })
      );
      return res.status(400).json({ ok: false, error: 'decision must be approved or rejected' });
    }
    const { decision, presentedDigest } = parsed.data;

    const record = listApprovalRequests({ status: 'pending' }).find(
      (item) => item.id === requestId
    );
    if (!record) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
          request_id: requestId,
          status: 404,
          error: 'approval request not found',
        })
      );
      return res.status(404).json({ ok: false, error: `approval request not found: ${requestId}` });
    }

    // FD-10/F4: decisions on this loopback surface are attributed to the
    // provisioned owner member (`user:<member_id>`), never a hardcoded
    // 'presence-studio'/'sovereign' label — and only through a membership
    // role that can actually record decisions (owner / approver).
    const requesterContext = record.requestedByContext as
      { tenant_slug?: string; tenantSlug?: string } | undefined;
    const loopContext = record.work_loop?.context as { tenant_slug?: string } | undefined;
    const recordTenant =
      requesterContext?.tenant_slug || requesterContext?.tenantSlug || loopContext?.tenant_slug;
    const decisionActor = resolveLoopbackDecisionActor(recordTenant);
    if (!decisionActor) {
      logger.warn(
        presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.reject', {
          request_id: requestId,
          status: 403,
          error: 'member binding could not be verified',
        })
      );
      return res.status(403).json({ ok: false, error: 'member binding could not be verified' });
    }

    try {
      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.accept', {
          request_id: requestId,
          decision,
          channel: record.channel || 'unknown',
          status: 202,
        })
      );
      const updated = decideApprovalRequest('surface_runtime', {
        channel: record.channel,
        storageChannel: record.storageChannel,
        requestId,
        decision,
        decidedBy: decisionActor.actorId,
        decidedByRole: decisionActor.role,
        // HA-05: a loopback viewer proves local access only — no verified session.
        authMethod: surfaceDecisionAuthMethod({ provider: 'loopback-local' }, true),
        decidedByType: 'human',
        authenticated: true,
        ...surfaceDecisionBinding(record, presentedDigest),
        note: 'Decision captured from Presence Studio approval inbox.',
      });
      logger.info(
        presenceStudioData.presenceStudioAuditLine(req, 'approvals/decision.complete', {
          request_id: requestId,
          decision,
          status: 200,
        })
      );
      return res.json({ ok: true, item: updated });
    } catch (error: unknown) {
      return res.status(500).json(presenceStudioData.presenceStudioWireError(error, 500));
    }
  });
}
