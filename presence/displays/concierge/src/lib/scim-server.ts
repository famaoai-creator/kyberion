/**
 * Server side of `/scim/v2` (SCIM 2.0 Users provisioning).
 *
 *  - The ONLY credential is a SCIM provisioning token in the Authorization
 *    header. Loopback, session cookies, member tokens and the localadmin
 *    token never reach SCIM; the tenant comes from the verified token, never
 *    from the request.
 *  - Every response is `application/scim+json`; failures use the SCIM Error
 *    message schema. Internal errors never echo the exception.
 *  - Requests are rate limited per client address before authentication and
 *    per verified token after it, each per method. Bodies are capped at 64 KiB
 *    before they are buffered.
 *  - Provisioning runs in an execution context bound to the token's tenant.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { createLogger } from '@agent/core/logger';
import * as secureIo from '@agent/core/secure-io';
import {
  SCIM_CONTENT_TYPE,
  ScimError,
  scimErrorBody,
  type ScimStatus,
} from '@agent/core/organization/scim-protocol';
import {
  authenticateScimToken,
  type ScimPrincipal,
} from '@agent/core/organization/scim-token-registry';
import { extractSurfaceBearerToken } from '@agent/core/surface/surface-mutation-guard';
import { resolveSurfaceBrowserUrl, resolveSurfaceUrl } from '@agent/core/surface/surface-url';
import { toWireError } from '@agent/core/wire-error';
import { checkConciergeRateLimit, conciergeClientAddress } from './viewer-context';

const logger = createLogger('concierge-scim');

/** Per client address and per token, each per method and minute. An IdP sync cycle stays well below it. */
export const SCIM_RATE_LIMIT_PER_MINUTE = 300;
const SCIM_BODY_MAX_BYTES = 64 * 1024;

export function scimResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): NextResponse {
  return new NextResponse(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': `${SCIM_CONTENT_TYPE}; charset=utf-8`,
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function scimFailure(
  status: ScimStatus,
  detail: string,
  scimType?: ScimError['scimType'],
  headers: Record<string, string> = {}
): NextResponse {
  return scimResponse(scimErrorBody(status, detail, scimType), status, headers);
}

export function scimErrorResponse(error: unknown): NextResponse {
  if (error instanceof ScimError) return scimFailure(error.status, error.message, error.scimType);
  const safe = toWireError({ status: 500, message: String(error) });
  logger.warn(
    `SCIM request failed — ${error instanceof Error ? error.name : 'unknown error'} | inspect the audit chain (scim.*) | correlation_id=${safe.correlation_id}`
  );
  return scimFailure(500, `${safe.message} (correlation_id=${safe.correlation_id})`);
}

/**
 * `<origin>/scim/v2`, used for `meta.location` and `Location`. The declared
 * public origin (`KYBERION_OIDC_PUBLIC_BASE_URL(S)`) wins; only without one
 * does the request origin (Host header) apply.
 */
export function scimBaseUrl(req: NextRequest): string {
  const publicOrigin = resolveSurfaceBrowserUrl('concierge');
  const declared = publicOrigin !== resolveSurfaceUrl('concierge');
  return `${declared ? publicOrigin : req.nextUrl.origin}/scim/v2`;
}

function withScimContext<T>(tenantSlug: string | undefined, fn: () => T): T {
  return withExecutionContext(
    'sovereign_concierge',
    () => secureIo.withSensitivePathMediation(fn),
    undefined,
    tenantSlug
  );
}

function rateLimited(req: NextRequest, key: string): NextResponse | null {
  const limited = checkConciergeRateLimit(req, { limit: SCIM_RATE_LIMIT_PER_MINUTE, key });
  if (limited.ok) return null;
  return scimFailure(
    429,
    'Too many requests',
    undefined,
    limited.retryAfterSeconds ? { 'Retry-After': String(limited.retryAfterSeconds) } : {}
  );
}

/**
 * Rate limit by client address (the bearer is unverified and caller-chosen,
 * so it cannot be the key), authenticate the SCIM token, then rate limit per
 * verified token. Never consults the viewer resolver.
 */
export function authenticateScimRequest(
  req: NextRequest
): { principal: ScimPrincipal; response?: never } | { principal?: never; response: NextResponse } {
  const byAddress = rateLimited(req, `scim-ip:${conciergeClientAddress(req)}`);
  if (byAddress) return { response: byAddress };
  const bearer = extractSurfaceBearerToken(req.headers.get('authorization'));
  const principal = bearer
    ? withScimContext(undefined, () =>
        authenticateScimToken(bearer, { method: req.method, path: req.nextUrl.pathname })
      )
    : null;
  if (!principal) {
    return {
      response: scimFailure(401, 'A valid SCIM provisioning token is required', undefined, {
        'WWW-Authenticate': 'Bearer realm="kyberion-scim"',
      }),
    };
  }
  const byToken = rateLimited(req, `scim-token:${principal.token_id}`);
  if (byToken) return { response: byToken };
  return { principal };
}

/** Read at most `limit` bytes of the body; larger bodies fail without being buffered. */
async function readBoundedText(req: NextRequest, limit: number): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      throw new ScimError(400, 'invalidSyntax', 'invalid Content-Length');
    }
    if (length > limit) throw new ScimError(413, undefined, 'request body is too large');
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new ScimError(413, undefined, 'request body is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a SCIM JSON body: SCIM or plain JSON content type, bounded, an object. */
export async function readScimBody(req: NextRequest): Promise<unknown> {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== SCIM_CONTENT_TYPE && type !== 'application/json') {
    throw new ScimError(415, undefined, `Content-Type must be ${SCIM_CONTENT_TYPE}`);
  }
  const text = await readBoundedText(req, SCIM_BODY_MAX_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScimError(400, 'invalidSyntax', 'request body is not valid JSON');
  }
}

/**
 * Route wrapper: authenticate, run `handler` in the token tenant's execution
 * context, and map every failure onto the SCIM error envelope.
 */
export async function handleScim(
  req: NextRequest,
  handler: (principal: ScimPrincipal, baseUrl: string) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  const auth = authenticateScimRequest(req);
  if (auth.response) return auth.response;
  try {
    return await handler(auth.principal, scimBaseUrl(req));
  } catch (error) {
    return scimErrorResponse(error);
  }
}

/** Run a provisioning operation bound to the principal's tenant. */
export function runScim<T>(principal: ScimPrincipal, fn: () => T): T {
  return withScimContext(principal.tenant_slug, fn);
}
