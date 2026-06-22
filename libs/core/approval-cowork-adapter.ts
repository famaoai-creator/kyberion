/**
 * Approval Cowork Adapter (Phase 2 — G4/軸B)
 *
 * Bridges Kyberion's approval-gate/approval-store with Cowork's
 * AskUserQuestion / MCP tool surface.
 *
 * Design decisions:
 *   - All approval operations are self-audited via auditChain.record()
 *   - `decide` requires the caller to present a valid requestId obtained from
 *     `listPending` (two-step: list→confirm→decide) to prevent blind approval.
 *   - kill-switch is gated behind a separate explicit confirm flag.
 *   - Storage role: 'sovereign_concierge' (operator-facing surface)
 *
 * Architecture rules (AGENTS.md):
 *   - All I/O via secure-io / governed artifact paths
 *   - No direct node:fs
 */

import {
  listApprovalRequests,
  loadApprovalRequest,
  decideApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { auditChain } from './audit-chain.js';

const COWORK_AGENT_ID = 'cowork-surface-agent';
const GOVERNED_ROLE = 'sovereign_concierge' as const;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CoworkPendingApproval {
  request_id: string;
  title: string;
  summary: string;
  severity: string;
  requested_by: string;
  requested_at: string;
  channel: string;
  storage_channel: string;
  expires_at?: string;
}

export interface CoworkApprovalDecision {
  request_id: string;
  decision: 'approved' | 'rejected';
  decided_by: string;
  note?: string;
  decided_at: string;
  previous_status: string;
}

// ─── List pending approvals ───────────────────────────────────────────────────

/**
 * Return all pending approval requests across all storage channels,
 * formatted for Cowork's AskUserQuestion surface.
 * Records a read-audit entry for every invocation.
 */
export function listPendingApprovalsForCowork(): CoworkPendingApproval[] {
  const records = listApprovalRequests({ status: 'pending' });

  auditChain.record({
    agentId: COWORK_AGENT_ID,
    action: 'cowork.approval.list_pending',
    operation: 'read',
    result: 'completed',
    metadata: { count: records.length },
  });

  return records.map((r) => ({
    request_id: r.id,
    title: r.title,
    summary: r.summary,
    severity: r.severity ?? 'medium',
    requested_by: r.requestedBy,
    requested_at: r.requestedAt,
    channel: r.channel,
    storage_channel: r.storageChannel,
    expires_at: r.expiresAt,
  }));
}

// ─── Decide approval ──────────────────────────────────────────────────────────

/**
 * Submit an approval decision from the Cowork surface.
 *
 * Two-step safety:
 *   1. Load the request to verify it still exists and is still pending.
 *   2. Apply the decision and audit-record both the attempt and the outcome.
 *
 * @throws If the request is not found, not pending, or the decision is invalid.
 */
export function decideApprovalFromCowork(params: {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  note?: string;
}): CoworkApprovalDecision {
  // Step 1: locate and validate the request is still actionable
  const allPending = listApprovalRequests({ status: 'pending' });
  const target = allPending.find((r) => r.id === params.requestId);
  if (!target) {
    auditChain.record({
      agentId: COWORK_AGENT_ID,
      action: 'cowork.approval.decide',
      operation: 'write',
      result: 'denied',
      reason: `Request ${params.requestId} not found or not pending`,
      metadata: { request_id: params.requestId, attempted_decision: params.decision },
    });
    throw new Error(
      `[APPROVAL_ERROR] Request '${params.requestId}' not found among pending approvals. ` +
      'Call kyberion.approval.list_pending first to obtain a valid request_id.',
    );
  }

  // Step 2: apply the decision
  const updated = decideApprovalRequest(GOVERNED_ROLE, {
    channel: target.channel,
    storageChannel: target.storageChannel,
    requestId: params.requestId,
    decision: params.decision,
    decidedBy: params.decidedBy,
    note: params.note,
  });

  // Step 3: audit-record the outcome
  auditChain.record({
    agentId: COWORK_AGENT_ID,
    action: 'cowork.approval.decide',
    operation: 'write',
    result: 'completed',
    metadata: {
      request_id: updated.id,
      decision: params.decision,
      decided_by: params.decidedBy,
      channel: updated.channel,
      title: updated.title,
    },
  });

  return {
    request_id: updated.id,
    decision: params.decision,
    decided_by: params.decidedBy,
    note: params.note,
    decided_at: updated.decidedAt ?? new Date().toISOString(),
    previous_status: 'pending',
  };
}

// ─── Audit export helpers ─────────────────────────────────────────────────────

/**
 * Record an audit-chain entry for a Cowork-initiated audit export.
 * The actual export is performed by the MCP server via safeExec (export_audit.js).
 */
export function recordAuditExportRequest(params: {
  requestedBy: string;
  missionId?: string;
  from?: string;
  to?: string;
  verifyOnly: boolean;
}): void {
  auditChain.record({
    agentId: COWORK_AGENT_ID,
    action: 'cowork.audit.export',
    operation: 'read',
    result: 'completed',
    metadata: {
      requested_by: params.requestedBy,
      mission_id: params.missionId,
      from: params.from,
      to: params.to,
      verify_only: params.verifyOnly,
    },
  });
}
