/** Test-only simulation helpers. Approval transitions use the real governed
 * store; caller must run under Vitest's isolated storage and human fixture. */
import { randomUUID } from 'node:crypto';
import {
  decideApprovalRequest,
  loadApprovalRequest,
  computeApprovalPresentedDigest,
  type ApprovalRequestRecord,
  approvalStoreRoots,
  VITEST_APPROVAL_STORE_ROOT,
} from '@agent/core/governance/approval-store';
import { isVitestProcess, getRegisteredEnvText } from '@agent/core/foundation/env';
import { withExecutionContext } from '@agent/core/authority';
import { rootResolve } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';
import {
  ExternalOperationApprovalRequired,
  type ExternalOperationAuthority,
} from '@agent/core/governance/external-operation';

export function simulationAuthority(
  label: string,
  tenantSlug = 'simulation-tenant'
): ExternalOperationAuthority {
  return { agentId: `simulation-${label}`, tenantSlug, invocationId: randomUUID(), hasHuman: true };
}

export async function captureSimulationApproval(
  execute: () => unknown | Promise<unknown>
): Promise<ApprovalRequestRecord> {
  try {
    await execute();
  } catch (error) {
    if (!(error instanceof ExternalOperationApprovalRequired) || !error.approval.requestId)
      throw error;
    const record = loadApprovalRequest('external-operation', error.approval.requestId);
    if (!record) throw new Error('Simulation approval request was not persisted');
    return record;
  }
  throw new Error('Simulation expected a pending approval before transport');
}

export function approveSimulationRequest(
  request: ApprovalRequestRecord | string,
  channel = 'external-operation'
): ApprovalRequestRecord {
  if (
    !isVitestProcess() ||
    !getRegisteredEnvText('KYBERION_VITEST_RUN_ID') ||
    !process.env.VITEST_POOL_ID
  ) {
    throw new Error('Simulation human fixture refuses a non-Vitest process');
  }
  const record = typeof request === 'string' ? loadApprovalRequest(channel, request) : request;
  if (!record) throw new Error('Simulation approval request missing');
  return decideApprovalRequest('mission_controller', {
    channel: record.channel,
    requestId: record.id,
    decision: 'approved',
    decidedBy: 'user:simulation-reviewer',
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
    presentedDigest: computeApprovalPresentedDigest(record),
  });
}

/** Clear only this Vitest run/pool's external-operation approval channel. */
export function cleanupSimulationApprovals(): void {
  const roots = approvalStoreRoots();
  if (
    !isVitestProcess() ||
    !getRegisteredEnvText('KYBERION_VITEST_RUN_ID') ||
    !process.env.VITEST_POOL_ID ||
    !Object.values(roots).every((root) => root.startsWith(`${VITEST_APPROVAL_STORE_ROOT}/run-`))
  ) {
    throw new Error('Simulation cleanup refuses a non-isolated approval store');
  }
  withExecutionContext('mission_controller', () => {
    for (const root of Object.values(roots))
      safeRmSync(rootResolve(`${root}/external-operation`), { recursive: true, force: true });
  });
}
