import { NextRequest, NextResponse } from 'next/server';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import { claimFirstRunForRequest, firstRunOpen } from '../../../../lib/first-run-server';
import { readRequestObject } from '../../../../lib/request-input';
import { checkConciergeRateLimit, guardConciergeRequest } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Public: only whether first-run setup is still open — nothing else leaks. */
export function GET(req: NextRequest) {
  const limited = guardConciergeRequest(req);
  if (limited) return limited;
  return NextResponse.json(
    { ok: true, state: firstRunOpen() ? 'unclaimed' : 'claimed' },
    { headers: NO_STORE }
  );
}

/**
 * Claim first-run setup with the one-time code issued on the host. No viewer
 * credential exists yet, so the code is the proof; the request must still come
 * from this origin's own page and is tightly rate-limited.
 */
export async function POST(req: NextRequest) {
  const limited = checkConciergeRateLimit(req, { limit: 10 });
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited' },
      {
        status: 429,
        headers: limited.retryAfterSeconds
          ? { 'Retry-After': String(limited.retryAfterSeconds) }
          : undefined,
      }
    );
  }
  if (
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  ) {
    return NextResponse.json({ ok: false, error: 'cross_origin' }, { status: 403 });
  }
  const parsed = await readRequestObject(req, 'request body', [
    'code',
    'tenant_slug',
    'tenant_display_name',
    'display_name',
  ]);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  }
  const result = claimFirstRunForRequest(parsed.body);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, ...(result.field ? { field: result.field } : {}) },
      { status: result.status, headers: NO_STORE }
    );
  }
  return NextResponse.json(result, { headers: NO_STORE });
}
