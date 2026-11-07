/**
 * Shared answers for the `/api/first-job*` routes (moved from presence-studio
 * `first-job-routes.ts`). The wire shape is Studio's
 * `{ ok: false, error: <code>, retry_safe, next_action }`; the page maps every
 * code to its own vocabulary and never shows it raw.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { createLogger } from '@agent/core/logger';
import { FIRST_JOB_NEXT_ACTION } from '@agent/core/surface/first-job';
import { conciergeErrorBody } from './viewer-context';
import type { FirstJobGateDenial } from './first-job-access';

const logger = createLogger('concierge-first-job');

export const FIRST_JOB_NO_STORE = { 'Cache-Control': 'no-store' } as const;
/** Studio's `express.json({ limit: '1mb' })`. */
const BODY_LIMIT_BYTES = 1024 * 1024;

export function firstJobFailure(
  status: number,
  error: string,
  retrySafe: boolean,
  extra: Record<string, unknown> = {}
): NextResponse {
  return NextResponse.json(
    { ok: false, error, retry_safe: retrySafe, next_action: FIRST_JOB_NEXT_ACTION, ...extra },
    { status, headers: FIRST_JOB_NO_STORE }
  );
}

/**
 * A refused gate. A cross-origin or Concierge-own refusal (rate limit, write
 * guard) is always safe to retry; an access refusal carries the route's own
 * `retry_safe` (Studio differs per route).
 */
export function firstJobGateFailure(
  denial: FirstJobGateDenial,
  accessRetrySafe: boolean
): Response {
  const response = firstJobFailure(
    denial.status,
    denial.error,
    denial.retrySafe || denial.error === 'first_job_origin_denied' ? true : accessRetrySafe
  );
  if (denial.retryAfter) response.headers.set('Retry-After', denial.retryAfter);
  return response;
}

/**
 * An unexpected failure: Studio's coded 503, plus the correlation id the cause
 * is logged under (`conciergeErrorBody`).
 */
export function firstJobUnexpected(
  route: string,
  error: unknown,
  code: string,
  retrySafe: boolean
): NextResponse {
  const { body } = conciergeErrorBody(error, 500);
  logger.error(
    `${route} failed — ${error instanceof Error ? error.message : String(error)} | next: check the front-desk conversation, approval and dot stores and the process role | evidence: correlation_id=${body.correlation_id}`
  );
  return firstJobFailure(503, code, retrySafe, { correlation_id: body.correlation_id });
}

/** Express-style query object: a repeated key is an array, so strict parsers refuse it. */
export function firstJobQuery(req: NextRequest): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of req.nextUrl.searchParams) {
    const current = query[key];
    query[key] =
      current === undefined
        ? value
        : Array.isArray(current)
          ? [...current, value]
          : [current, value];
  }
  return query;
}

/** The JSON body, or `undefined` when it is missing, too large or not JSON. */
export async function readFirstJobBody(req: NextRequest): Promise<unknown> {
  try {
    const text = await req.text();
    if (!text || Buffer.byteLength(text, 'utf8') > BODY_LIMIT_BYTES) return undefined;
    return parseSafeJsonInput(text, 'first-job request body');
  } catch {
    return undefined;
  }
}
