import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { createInviteEmailDraft } from '../../../../lib/invite-email';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { resolveConciergeLocale } from '../../../../lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * Puts the invite into a mail DRAFT for the inviter to review and send. Nothing
 * is sent from here; the draft is created in the inviter's own mail backend.
 */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'tenant_slug',
      'code',
      'email',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const locale = resolveConciergeLocale(req.nextUrl.searchParams.get('locale') || undefined);
    const result = await withExecutionContext('sovereign_concierge', () =>
      secureIo.withSensitivePathMediation(() =>
        createInviteEmailDraft(resolved.context, parsedBody.body ?? {}, req.nextUrl.origin, locale)
      )
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
