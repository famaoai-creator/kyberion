import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import { computeApprovalPresentedDigest } from '@agent/core/governance/approval-presentation';
import {
  describeProviderTierAvailability,
  loadProviderEgressPolicy,
} from '@agent/core/provider/provider-egress-gate';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import {
  attestTenantProvider,
  PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
  requestTenantProviderAttestationApproval,
  type AttestationInvoker,
} from '@agent/core/organization/tenant-governance';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { readRequestObject } from '../../../lib/request-input';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
const response = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });

function tenantAllowed(viewer: { tenantSlugs: string[] | 'all' }, tenant: string): boolean {
  return viewer.tenantSlugs === 'all' || viewer.tenantSlugs.includes(tenant);
}

function attestationInvoker(viewer: {
  memberId?: string;
  principalId?: string;
}): AttestationInvoker | null {
  // Attestation requests/records must be attributed to a member-bound viewer;
  // without memberId there is no verifiable identity to record.
  if (!viewer.memberId) return null;
  const actor = `user:${viewer.memberId}`;
  return {
    actor,
    approvalRequester: {
      requestedBy: actor,
      actorId: actor,
    },
  };
}

export async function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const tenant = req.nextUrl.searchParams.get('tenant')?.trim();
  if (!tenant) return response({ ok: false, error: 'tenant is required' }, 400);
  if (!tenantAllowed(resolved.context, tenant)) {
    return response({ ok: false, error: 'tenant is outside the viewer scope' }, 403);
  }
  try {
    const value = await withExecutionContextAsync('sovereign_concierge', async () => {
      const policy = loadProviderEgressPolicy();
      const providers = policy.status === 'ok' ? Object.keys(policy.policy.providers).sort() : [];
      const profile = readTenantProfile(tenant);
      const availability = describeProviderTierAvailability({ tenant_slug: tenant });
      const pending = listApprovalRequests({
        storageChannels: [PROVIDER_ATTESTATION_APPROVAL_CHANNEL],
        status: ['pending', 'approved'],
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: tenant },
      }).map((record) => ({
        request_id: record.id,
        status: record.status,
        expires_at: record.expiresAt,
        approval_channel: PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
        presented_digest: computeApprovalPresentedDigest(record),
      }));
      return {
        ok: true,
        tenant,
        providers,
        attestations: profile?.provider_attestations ?? {},
        availability,
        pending_requests: pending,
        policy_status: policy.status,
      };
    });
    return response(value);
  } catch (error) {
    return response(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const parsed = await readRequestObject(req, 'request body', [
    'action',
    'tenant',
    'provider',
    'training_use',
    'plan',
    'basis',
    'attested_by',
    'valid_for_days',
    'approval_request_id',
  ]);
  if (!parsed.ok) return response({ ok: false, error: parsed.error }, 400);
  const body = parsed.body as Record<string, unknown>;
  const action = body.action;
  const tenant = typeof body.tenant === 'string' ? body.tenant.trim() : '';
  const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
  const trainingUse = body.training_use;
  if (!tenant || !provider) {
    return response({ ok: false, error: 'tenant and provider are required' }, 400);
  }
  if (!tenantAllowed(resolved.context, tenant)) {
    return response({ ok: false, error: 'tenant is outside the viewer scope' }, 403);
  }
  if (trainingUse !== 'none' && trainingUse !== 'used' && trainingUse !== 'unknown') {
    return response({ ok: false, error: 'training_use must be none | used | unknown' }, 400);
  }
  const invoker = attestationInvoker(resolved.context);
  if (!invoker) {
    return response(
      {
        ok: false,
        error:
          'attestation requires a member-bound viewer session (link an identity to your member)',
      },
      403
    );
  }
  const input = {
    slug: tenant,
    provider,
    training_use: trainingUse as 'none' | 'used' | 'unknown',
    ...(typeof body.plan === 'string' && body.plan.trim() ? { plan: body.plan.trim() } : {}),
    ...(typeof body.basis === 'string' && body.basis.trim() ? { basis: body.basis.trim() } : {}),
    ...(typeof body.attested_by === 'string' && body.attested_by.trim()
      ? { attested_by: body.attested_by.trim() }
      : {}),
    ...(typeof body.valid_for_days === 'number' && Number.isInteger(body.valid_for_days)
      ? { valid_for_days: body.valid_for_days }
      : {}),
    invoker,
  };
  try {
    if (action === 'request') {
      const result = await withExecutionContextAsync('sovereign_concierge', async () =>
        requestTenantProviderAttestationApproval(input)
      );
      return response({ ok: true, ...result });
    }
    if (action === 'record') {
      const approvalRequestId =
        typeof body.approval_request_id === 'string' ? body.approval_request_id.trim() : '';
      const result = await withExecutionContextAsync('sovereign_concierge', async () =>
        attestTenantProvider({
          ...input,
          ...(approvalRequestId ? { approvalRequestId } : {}),
        })
      );
      return response({ ok: true, ...result });
    }
    return response({ ok: false, error: "action must be 'request' or 'record'" }, 400);
  } catch (error) {
    return response(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      400
    );
  }
}
