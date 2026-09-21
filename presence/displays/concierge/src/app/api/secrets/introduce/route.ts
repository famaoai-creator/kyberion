import { NextRequest, NextResponse } from 'next/server';
import {
  describeIntroductionReadiness,
  proposeSecretIntroduction,
} from '@agent/core/secret-introduction';
import { listServiceSecretKeys } from '@agent/core/secret-identity';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { resolveConciergeDecidedBy } from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  try {
    const serviceId = req.nextUrl.searchParams.get('serviceId')?.trim();
    if (!serviceId) {
      return NextResponse.json({ ok: false, error: 'serviceId is required' }, { status: 400 });
    }
    const readiness = describeIntroductionReadiness(serviceId);
    return NextResponse.json({
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
    });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  const decidedBy = resolved.context ? resolveConciergeDecidedBy(resolved.context) : null;

  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'serviceId',
      'secretKey',
      'reason',
      'autoApprove',
      'riskLevel',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
    const secretKey = typeof body.secretKey === 'string' ? body.secretKey.trim() : '';
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Concierge secret introduction';
    if (!serviceId || !secretKey) {
      return NextResponse.json(
        { ok: false, error: 'serviceId and secretKey are required' },
        { status: 400 }
      );
    }

    const proposed = proposeSecretIntroduction({
      serviceId,
      secretKey,
      reason,
      autoApproveLocal: body.autoApprove !== false,
      riskLevel:
        body.riskLevel === 'medium' ||
        body.riskLevel === 'high' ||
        body.riskLevel === 'critical' ||
        body.riskLevel === 'low'
          ? body.riskLevel
          : 'low',
      channel: 'concierge',
      storageChannel: 'concierge',
      requestedBy: decidedBy?.id ?? 'concierge',
      decidedBy: decidedBy?.id ?? 'concierge',
      requestedByContext: {
        surface: 'api',
        actorId: decidedBy?.id ?? 'concierge',
        actorRole: decidedBy?.role ?? 'sovereign',
      },
    });

    return NextResponse.json({
      ok: true,
      approvalId: proposed.approvalId,
      status: proposed.status,
      autoApproved: proposed.autoApproved,
      envName: proposed.identity.envName,
      storageChannel: proposed.storageChannel,
      channel: proposed.channel,
      next:
        proposed.status === 'approved'
          ? 'POST /api/secrets/apply with approvalId and value'
          : 'Approve in Chronos or terminal, then apply',
    });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
