/**
 * The human-only final-decision contract (`accountability.finalDecision:
 * 'human_only'`), shared by the approval store and the consumers that re-check
 * a decision before applying it.
 */
import type { ApprovalAccountability, ApprovalRecord } from './approval-store.js';

export function validateHumanFinalDecision(params: {
  accountability?: ApprovalAccountability;
  decidedByType?: ApprovalRecord['decidedByType'];
  authenticated?: boolean;
  authMethod?: ApprovalRecord['authMethod'];
  payloadHash?: string;
  effectBinding?: string;
}): void {
  if (params.accountability?.finalDecision !== 'human_only') return;
  if (params.decidedByType !== 'human') {
    throw new Error('[POLICY_VIOLATION] Final approval requires a human decider');
  }
  if (params.authenticated !== true) {
    throw new Error('[POLICY_VIOLATION] Final approval requires an authenticated human decider');
  }
  if (params.authMethod === 'local_token') {
    throw new Error(
      '[POLICY_VIOLATION] Final approval requires a human-authenticated surface; local_token is not sufficient'
    );
  }
  if (
    params.accountability.payloadHash &&
    params.payloadHash !== params.accountability.payloadHash
  ) {
    throw new Error('[POLICY_VIOLATION] Approval payload hash does not match the requested effect');
  }
  if (
    params.accountability.effectBinding &&
    params.effectBinding !== params.accountability.effectBinding
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Approval effect binding does not match the requested operation'
    );
  }
}
