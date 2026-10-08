import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { loadApprovalRequest } from '@agent/core/governance/approval-store';
import {
  applySecretIntroduction,
  SECRET_INTRODUCTION_RECOVERY_REQUIRED,
} from '@agent/core/secret/secret-introduction';
import { readRequestObject } from '../../../../lib/request-input';
import {
  operatorServiceError,
  resolveOperatorServiceAccess,
} from '../../../../lib/operator-service-access';

export const dynamic = 'force-dynamic';

/** Legacy secret form shares the same local-only, principal-bound contract. */
export async function POST(req: NextRequest) {
  const access = resolveOperatorServiceAccess(req);
  if (access.response) return access.response;
  const parsed = await readRequestObject(req, 'request body', [
    'approvalId',
    'value',
    'channel',
    'storageChannel',
  ]);
  if (!parsed.ok) return operatorServiceError('invalid_request');
  const { body } = parsed;
  if (
    typeof body.approvalId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(body.approvalId) ||
    typeof body.value !== 'string' ||
    !body.value ||
    (body.channel !== undefined && body.channel !== 'concierge') ||
    (body.storageChannel !== undefined && body.storageChannel !== 'concierge')
  ) {
    return operatorServiceError('invalid_request');
  }
  try {
    return await withExecutionContextAsync('sovereign_concierge', async () => {
      const record = loadApprovalRequest('concierge', body.approvalId as string);
      if (!record?.target?.serviceId || !record.target.secretKey)
        return operatorServiceError('approval_required', 403);
      const principalId = access.principal.principalId!;
      const applied = await applySecretIntroduction({
        approvalId: body.approvalId as string,
        value: body.value as string,
        appliedBy: principalId,
        expected: {
          principalId,
          serviceId: record.target.serviceId,
          secretKey: record.target.secretKey,
          channel: 'concierge',
          storageChannel: 'concierge',
        },
      });
      return NextResponse.json(
        {
          ok: true,
          approvalId: applied.approvalId,
          status: applied.status,
          envName: applied.identity.envName,
          changedKeys: applied.changedKeys,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    });
  } catch (error) {
    return error instanceof Error && error.message === SECRET_INTRODUCTION_RECOVERY_REQUIRED
      ? operatorServiceError('recovery_required', 409)
      : operatorServiceError('approval_required', 403);
  }
}
