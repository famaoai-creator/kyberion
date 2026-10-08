import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import {
  describeIntroductionReadiness,
  proposeSecretIntroduction,
} from '@agent/core/secret/secret-introduction';
import { listServiceSecretKeys } from '@agent/core/secret/secret-identity';
import { readRequestObject } from '../../../../lib/request-input';
import {
  operatorServiceError,
  resolveOperatorServiceAccess,
} from '../../../../lib/operator-service-access';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  const access = resolveOperatorServiceAccess(req);
  if (access.response) return access.response;
  const serviceId = req.nextUrl.searchParams.get('serviceId')?.trim();
  if (!serviceId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(serviceId))
    return operatorServiceError('invalid_request');
  try {
    return await withExecutionContextAsync('sovereign_concierge', async () => {
      const readiness = describeIntroductionReadiness(serviceId);
      return NextResponse.json(
        {
          ok: true,
          readiness: {
            serviceId: readiness.serviceId,
            missing: readiness.missing,
            identities: readiness.identities.map((row) => ({
              envName: row.identity.envName,
              secretKey: row.identity.secretKey,
              present: row.present,
            })),
          },
          secretKeys: listServiceSecretKeys(serviceId),
        },
        { headers }
      );
    });
  } catch {
    return operatorServiceError('unavailable', 503);
  }
}

export async function POST(req: NextRequest) {
  const access = resolveOperatorServiceAccess(req);
  if (access.response) return access.response;
  const parsed = await readRequestObject(req, 'request body', [
    'serviceId',
    'secretKey',
    'reason',
    'autoApprove',
    'riskLevel',
  ]);
  if (!parsed.ok) return operatorServiceError('invalid_request');
  const { body } = parsed;
  const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
  const secretKey = typeof body.secretKey === 'string' ? body.secretKey.trim() : '';
  const risk = body.riskLevel ?? 'low';
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(serviceId) ||
    !secretKey ||
    !['low', 'medium', 'high', 'critical'].includes(String(risk)) ||
    (body.autoApprove !== undefined && typeof body.autoApprove !== 'boolean')
  )
    return operatorServiceError('invalid_request');
  try {
    return await withExecutionContextAsync('sovereign_concierge', async () => {
      if (!listServiceSecretKeys(serviceId).includes(secretKey))
        return operatorServiceError('invalid_request');
      const principalId = access.principal.principalId!;
      const proposed = proposeSecretIntroduction({
        serviceId,
        secretKey,
        reason:
          typeof body.reason === 'string' && body.reason.trim()
            ? body.reason.trim().slice(0, 1000)
            : 'Local operator requested Web secret registration',
        autoApproveLocal: body.autoApprove !== false,
        riskLevel: risk as 'low' | 'medium' | 'high' | 'critical',
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
          status: proposed.status,
          autoApproved: proposed.autoApproved,
          envName: proposed.identity.envName,
          storageChannel: 'concierge',
          channel: 'concierge',
          next:
            proposed.status === 'approved'
              ? 'POST /api/secrets/apply with approvalId and value'
              : 'Approve the request before applying the value',
        },
        { headers }
      );
    });
  } catch {
    return operatorServiceError('unavailable', 503);
  }
}
