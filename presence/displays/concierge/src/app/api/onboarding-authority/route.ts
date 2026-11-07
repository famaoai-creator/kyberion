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
import { createLogger } from '@agent/core/logger';
import { toWireError } from '@agent/core/wire-error';
import { resolveConciergeViewer } from '../../../lib/viewer-context';
import {
  asOnboardingOwner,
  onboardingAuthorityPrincipal,
} from '../../../lib/onboarding-authority-server';
import { readRequestObject } from '../../../lib/request-input';
import { requireConciergeInstallationAccess } from '../../../lib/installation-access';
export const dynamic = 'force-dynamic';
const logger = createLogger('concierge-onboarding-authority');
/**
 * Failures shown to the person, by allowlist: this domain's own refusals,
 * the principal / installation codes, the route's own literals and the
 * approval and charter refusals a person can cause (a repeated apply, a
 * changed request). Anything else (role, policy or storage violations, raw
 * fs errors) can carry internal detail such as absolute paths: it is logged
 * server-side under a correlation id and answered with the generic wire
 * error, never echoed to the browser.
 */
const ROUTE_REFUSALS = new Set([
  'invalid scope query',
  'invalid continuation fields',
  'request_id required',
  'reviewed digest required',
  'unknown authority action',
]);
const DOMAIN_REFUSAL =
  /^\[(?:ONBOARDING_AUTHORITY\] |POLICY_VIOLATION\] (?:Approval |A current approved |Final approval )|CHARTER_SCOPE_DENIED\] )/u;
const CODE = /^[a-z][a-z0-9_]{2,80}$/u;
const PATH_LIKE = /(?:^|[\s'"(=:])(?:\/|[A-Za-z]:\\|(?:active|knowledge|libs)\/)/u;
function onboardingAuthorityFailureIsShown(message: string): boolean {
  if (PATH_LIKE.test(message)) return false;
  return ROUTE_REFUSALS.has(message) || CODE.test(message) || DOMAIN_REFUSAL.test(message);
}
const response = (value: unknown, status = 200) =>
  NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'onboarding_authority_unavailable';
  if (!onboardingAuthorityFailureIsShown(message)) {
    const safe = toWireError({ status: 500, message });
    logger.warn(
      `onboarding authority request failed — internal error | next: inspect the core failure | evidence: correlation_id=${safe.correlation_id} ${message}`
    );
    return response(
      {
        ok: false,
        error: safe.message,
        error_code: safe.code,
        correlation_id: safe.correlation_id,
      },
      500
    );
  }
  if (message === 'authentication_required') return response({ ok: false, error: message }, 401);
  if (message === 'installation_owner_required' || message === 'installation_step_up_required')
    return response({ ok: false, error: message, error_code: message }, 403);
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
      'delegated_decisions',
      'data_tier',
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
    // The personal scope is installation scope: requesting or applying a
    // change needs the installation write gate (loopback or passkey step-up).
    if (scope.kind === 'person' && (action === 'request' || action === 'apply')) {
      const gate = requireConciergeInstallationAccess(
        resolved.context,
        'write',
        req,
        `onboarding_authority ${action}`
      );
      if (gate.response) return gate.response;
    }
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
