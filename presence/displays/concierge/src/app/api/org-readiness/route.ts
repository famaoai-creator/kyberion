import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import * as secureIo from '@agent/core/secure-io';
import { readOrgReadiness } from '../../../lib/org-readiness-server';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const asContext = <T>(fn: () => T): T =>
  withExecutionContext('sovereign_concierge', () => secureIo.withSensitivePathMediation(fn));

/** Set-up progress of the organizations where the viewer is an owner or approver. Read-only. */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const organizations = asContext(() => readOrgReadiness(resolved.context));
    return NextResponse.json(
      { ok: true, organizations },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
