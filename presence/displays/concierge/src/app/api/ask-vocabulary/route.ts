import { NextResponse, type NextRequest } from 'next/server';
import { t as catalogT } from '@agent/core/t';
import { hearingQueryLocale } from '@agent/core/surface/hearing-session-service';
import { ASK_VOCABULARY_KEYS } from '@agent/core/surface/ask-view';
import { hearingQuery } from '../../../lib/hearing-access';
import { resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

/**
 * The ask page's vocabulary: exactly `ASK_VOCABULARY_KEYS`, raw templates in
 * the requested locale (moved from presence-studio `GET /api/ask-vocabulary`).
 * Carries no data; like every Studio API it still needs a resolved viewer
 * (an anonymous remote request is refused 401).
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const locale = hearingQueryLocale(hearingQuery(req));
  const texts = Object.fromEntries(
    ASK_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
  );
  return NextResponse.json(
    { ok: true, locale, texts },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
