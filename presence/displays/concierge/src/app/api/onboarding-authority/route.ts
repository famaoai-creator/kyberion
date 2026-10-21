import { NextRequest, NextResponse } from 'next/server';
import {
  onboardingAuthorityScope,
  readOnboardingAuthority,
  previewOnboardingAuthority,
  requestOnboardingAuthority,
  onboardingAuthorityRequestStatus,
  applyOnboardingAuthority,
} from '@agent/core/organization/onboarding-authority';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { resolveConciergeViewer } from '../../../lib/viewer-context';
import {
  asOnboardingOwner,
  onboardingAuthorityPrincipal,
} from '../../../lib/onboarding-authority-server';
import { readRequestObject } from '../../../lib/request-input';
export const dynamic = 'force-dynamic';
const response = (value: unknown, status = 200) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'onboarding_authority_unavailable';
  const requiredAt = message.indexOf('required');
  const denied =
    ['owner', 'outside', 'member'].some((part) => message.includes(part)) ||
    (requiredAt >= 0 && message.indexOf('scope', requiredAt + 'required'.length) >= 0);
  return response({ ok: false, error: message }, denied ? 403 : 400);
}
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const keys = ['scope_kind', 'tenant_slug'];
    for (const key of req.nextUrl.searchParams.keys())
      if (!keys.includes(key) || req.nextUrl.searchParams.getAll(key).length !== 1)
        throw new Error('invalid scope query');
    const scope = onboardingAuthorityScope(Object.fromEntries(req.nextUrl.searchParams));
    const principal = onboardingAuthorityPrincipal(resolved.context, scope);
    return response(asOnboardingOwner(() => readOnboardingAuthority(principal, scope)));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsed = await readRequestObject(req, 'request body', [
      'action',
      'scope_kind',
      'tenant_slug',
      'grants',
      'expires_at',
      'mode',
      'renew_existing',
      'digest',
      'base_hash',
      'request_id',
    ]);
    if (!parsed.ok) return response({ ok: false, error: parsed.error }, 400);
    const { action, digest, base_hash, request_id, ...input } = parsed.body;
    const scope = onboardingAuthorityScope(input);
    const principal = onboardingAuthorityPrincipal(resolved.context, scope);
    const result = asOnboardingOwner(() => {
      if (action === 'preview') return previewOnboardingAuthority(principal, input);
      if (action === 'request') {
        if (typeof digest !== 'string' || typeof base_hash !== 'string')
          throw new Error('reviewed digest required');
        return requestOnboardingAuthority(principal, input, { digest, base_hash });
      }
      if (typeof request_id !== 'string') throw new Error('request_id required');
      if (Object.keys(input).some((key) => !['scope_kind', 'tenant_slug'].includes(key)))
        throw new Error('invalid continuation fields');
      if (action === 'status')
        return onboardingAuthorityRequestStatus(principal, scope, request_id);
      if (action === 'apply') return applyOnboardingAuthority(principal, scope, request_id);
      throw new Error('unknown authority action');
    });
    return response(result);
  } catch (error) {
    return failure(error);
  }
}
