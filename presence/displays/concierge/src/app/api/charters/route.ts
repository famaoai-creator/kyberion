import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { resolveConciergeLocale } from '../../../lib/i18n';
import {
  acceptCharterForViewer,
  dismissCharterProposal,
  proposeCharter,
  previewCharter,
  readCharterOverview,
} from '../../../lib/charter-server';
import { readRequestObject } from '../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const asContext = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', () => secureIo.withSensitivePathMediation(fn));

/**
 * Accountability charters of the viewer's tenants. GET is a read of the
 * viewer's own scope (`?tenant=` may only narrow). POST is either `preview`
 * (returns the exact statement + its digest), `propose` / `dismiss_proposal`
 * (an approver drafts limits; the owner sets it aside), or `accept` (recomputes the
 * statement and refuses if its digest differs from what the human saw). The
 * accountable human is always the authenticated member, never a client field.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const locale = resolveConciergeLocale(req.nextUrl.searchParams.get('locale') ?? undefined);
    const overview = asContext(() =>
      readCharterOverview(
        resolved.context,
        req.nextUrl.searchParams.get('tenant'),
        {},
        new Date(),
        locale
      )
    );
    return NextResponse.json(
      { ok: true, ...overview },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'action',
      'form',
      'statement_sha256',
      'note',
      'tenant_slug',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const action = body?.action;
    if (
      action !== 'preview' &&
      action !== 'accept' &&
      action !== 'propose' &&
      action !== 'dismiss_proposal'
    ) {
      return NextResponse.json(
        { ok: false, error: 'action must be preview, accept, propose or dismiss_proposal' },
        { status: 400 }
      );
    }
    const result = asContext(() => {
      if (action === 'preview') return previewCharter(resolved.context, body?.form);
      if (action === 'propose') return proposeCharter(resolved.context, body?.form, body?.note);
      if (action === 'dismiss_proposal') {
        return dismissCharterProposal(resolved.context, body?.tenant_slug);
      }
      return acceptCharterForViewer(resolved.context, body?.form, body?.statement_sha256);
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
