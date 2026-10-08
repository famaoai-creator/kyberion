import { NextRequest, NextResponse } from 'next/server';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import {
  readSsoSettings,
  saveSsoSettings,
  viewerIsInstanceOwner,
} from '../../../../lib/first-run-server';
import { readRequestObject } from '../../../../lib/request-input';
import { resolveConciergeViewer } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function forbidden() {
  return NextResponse.json(
    { ok: false, error: 'instance_owner_required' },
    { status: 403, headers: NO_STORE }
  );
}

/** Instance owner only: the active SSO settings (never the client secret). */
export function GET(req: NextRequest) {
  const viewer = resolveConciergeViewer(req);
  if (viewer.response) return viewer.response;
  if (!viewerIsInstanceOwner(viewer.context)) return forbidden();
  return NextResponse.json({ ok: true, ...readSsoSettings() }, { headers: NO_STORE });
}

/** Instance owner only: store SSO settings in secret-guard (applies without restart). */
export async function PUT(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const viewer = resolveConciergeViewer(req);
  if (viewer.response) return viewer.response;
  if (!viewerIsInstanceOwner(viewer.context)) return forbidden();
  const parsed = await readRequestObject(req, 'request body', [
    'issuer',
    'client_id',
    'client_secret',
    'provider_label',
    'scopes',
    'public_base_url',
  ]);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  }
  const result = saveSsoSettings(viewer.context, parsed.body);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, ...(result.field ? { field: result.field } : {}) },
      { status: result.status, headers: NO_STORE }
    );
  }
  return NextResponse.json(result, { headers: NO_STORE });
}
