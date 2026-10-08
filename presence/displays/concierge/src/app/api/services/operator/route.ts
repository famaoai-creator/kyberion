import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { loadApprovalRequest } from '@agent/core/governance/approval-store';
import {
  listOperatorServiceConnections,
  probeOperatorServiceConnection,
} from '@agent/core/service/operator-service-connection';
import {
  applySecretIntroduction,
  proposeSecretIntroduction,
  SECRET_INTRODUCTION_RECOVERY_REQUIRED,
} from '@agent/core/secret/secret-introduction';
import { readRequestObject } from '../../../../lib/request-input';
import {
  operatorServiceError,
  resolveOperatorServiceAccess,
} from '../../../../lib/operator-service-access';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const knownFields: Record<string, readonly string[]> = {
  propose: ['action', 'serviceId'],
  apply: ['action', 'serviceId', 'approvalId', 'value'],
  probe: ['action', 'serviceId'],
  status: ['action', 'serviceId', 'approvalId'],
};

export async function GET(req: NextRequest) {
  const access = resolveOperatorServiceAccess(req);
  if (access.response) return access.response;
  try {
    const services = await withExecutionContextAsync('sovereign_concierge', async () =>
      listOperatorServiceConnections(access.principal)
    );
    return NextResponse.json({ ok: true, services }, { headers });
  } catch {
    return operatorServiceError('unavailable', 503);
  }
}

export async function POST(req: NextRequest) {
  const access = resolveOperatorServiceAccess(req);
  if (access.response) return access.response;
  const parsed = await readRequestObject(req, 'request body', [
    'action',
    'serviceId',
    'approvalId',
    'value',
  ]);
  if (!parsed.ok) return operatorServiceError('invalid_request');
  const body = parsed.body;
  if (
    typeof body.action !== 'string' ||
    !Object.hasOwn(knownFields, body.action) ||
    Object.keys(body).some((key) => !knownFields[body.action as string].includes(key)) ||
    typeof body.serviceId !== 'string'
  )
    return operatorServiceError('invalid_request');
  const action = body.action;
  const serviceId = body.serviceId;
  try {
    return await withExecutionContextAsync('sovereign_concierge', async () => {
      const service = listOperatorServiceConnections(access.principal).find(
        (entry) => entry.serviceId === serviceId
      );
      if (!service) return operatorServiceError('invalid_request');
      const principalId = access.principal.principalId!;
      if (action === 'status') {
        if (typeof body.approvalId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.approvalId))
          return operatorServiceError('invalid_request');
        const approval = loadApprovalRequest('concierge', body.approvalId);
        const expiresAt = approval?.expiresAt ? Date.parse(approval.expiresAt) : NaN;
        if (
          !approval ||
          approval.kind !== 'secret_mutation' ||
          approval.requestedBy !== principalId ||
          approval.requestedByContext?.actorId !== principalId ||
          approval.target?.serviceId !== serviceId ||
          approval.target?.secretKey !== service.secretKey ||
          approval.target.store !== 'os_keychain' ||
          !['set', 'rotate'].includes(String(approval.target.mutation)) ||
          approval.channel !== 'concierge' ||
          approval.storageChannel !== 'concierge' ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= Date.now() ||
          !['pending', 'approved'].includes(approval.status) ||
          approval.applyClaim ||
          approval.applyResult
        ) {
          return operatorServiceError('approval_required', 403);
        }
        return NextResponse.json(
          { ok: true, approvalId: approval.id, status: approval.status },
          { headers }
        );
      }
      if (action === 'propose') {
        const proposed = proposeSecretIntroduction({
          serviceId,
          secretKey: service.secretKey,
          reason: 'Local operator requested Web service registration',
          autoApproveLocal: true,
          riskLevel: 'low',
          channel: 'concierge',
          storageChannel: 'concierge',
          requestedBy: principalId,
          decidedBy: principalId,
          requestedByContext: { surface: 'api', actorId: principalId, actorRole: 'sovereign' },
        });
        return NextResponse.json(
          {
            ok: true,
            approvalId: proposed.approvalId,
            status: proposed.status === 'approved' ? 'approved' : 'pending',
          },
          { headers }
        );
      }
      if (action === 'probe') {
        const result = await probeOperatorServiceConnection({
          principal: access.principal,
          serviceId,
        });
        return NextResponse.json(
          {
            ok: true,
            serviceId: result.serviceId,
            status: result.status,
            checkedAt: result.checkedAt,
          },
          { headers }
        );
      }
      if (
        typeof body.approvalId !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(body.approvalId) ||
        typeof body.value !== 'string' ||
        !body.value
      )
        return operatorServiceError('invalid_request');
      try {
        await applySecretIntroduction({
          approvalId: body.approvalId,
          value: body.value,
          appliedBy: principalId,
          expected: {
            principalId,
            serviceId,
            secretKey: service.secretKey,
            storageChannel: 'concierge',
            channel: 'concierge',
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === SECRET_INTRODUCTION_RECOVERY_REQUIRED) {
          return operatorServiceError('recovery_required', 409);
        }
        return operatorServiceError('approval_required', 403);
      }
      return NextResponse.json({ ok: true, serviceId, status: 'registered' }, { headers });
    });
  } catch {
    // Never serialize or log provider, keychain, approval, or resolver exceptions.
    return operatorServiceError('unavailable', 503);
  }
}
