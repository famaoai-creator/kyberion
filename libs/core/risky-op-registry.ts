/**
 * Risky Op Registry — thin wrapper around enforceApprovalGate that lets
 * callers invoke governance on a named operation without threading
 * intent_id / correlation_id boilerplate through every call site.
 *
 * Implements CONCEPT_INTEGRATION_BACKLOG P2-6 at the call-site ergonomics
 * layer. The authoritative approval rules live in
 * knowledge/public/governance/approval-policy.json; this module only
 * adds a minimal dispatcher plus stable op IDs that downstream code can
 * reference from a single place.
 */

import { randomUUID } from 'node:crypto';
import { enforceApprovalGate, type ApprovalGateResult } from './approval-gate.js';

/** Canonical op IDs for risky operations enforced by the approval gate. */
export const RISKY_OPS = {
  SECRET_GRANT_ACCESS: 'secret:grant_access',
  AUTH_GRANT_AUTHORITY: 'auth:grant_authority',
  CONFIG_UPDATE: 'config:update',
  VAULT_WRITE: 'vault:write',
  CLAUDE_BROWSER_INTERACTIVE: 'claude:browser_interactive',
  CLAUDE_DOCUMENT_GENERATION: 'claude:document_generation',
} as const;

export type RiskyOpId = typeof RISKY_OPS[keyof typeof RISKY_OPS];

export interface RequireApprovalParams {
  opId: RiskyOpId | string;
  agentId: string;
  /** Caller's correlation id. Auto-generated if omitted. */
  correlationId?: string;
  /** Typically 'cli', 'slack', or a specific surface channel id. */
  channel?: string;
  /** Operation-specific details surfaced to the approver. */
  payload?: Record<string, unknown>;
  /** Pre-built approval draft. Auto-generated when omitted. */
  draft?: {
    title: string;
    summary: string;
    severity?: 'low' | 'medium' | 'high';
  };
}

/**
 * Gate a risky operation. Returns the approval decision; callers must
 * short-circuit on `result.allowed === false`. The canonical usage is:
 *
 * ```ts
 * const approval = requireApprovalForOp({
 *   opId: RISKY_OPS.SECRET_GRANT_ACCESS,
 *   agentId: 'mission_controller',
 *   payload: { missionId, serviceId, ttlMinutes },
 * });
 * if (!approval.allowed) throw new Error(approval.message ?? 'approval required');
 * ```
 *
 * The underlying policy evaluation reads approval-policy.json via
 * resolveApprovalPolicy. Ops not listed there fall through with
 * requires_approval=false.
 */
export function requireApprovalForOp(params: RequireApprovalParams): ApprovalGateResult {
  const correlationId = params.correlationId ?? randomUUID();
  return enforceApprovalGate({
    operationId: params.opId,
    agentId: params.agentId,
    correlationId,
    channel: params.channel ?? 'system',
    intentId: params.opId,
    payload: params.payload,
    draft: params.draft,
  });
}

/** Whether an op id is one the registry explicitly recognises. */
export function isKnownRiskyOp(opId: string): opId is RiskyOpId {
  return (Object.values(RISKY_OPS) as string[]).includes(opId);
}
