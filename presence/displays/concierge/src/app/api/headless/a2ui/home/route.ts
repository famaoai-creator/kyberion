import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeConciergeOperation,
  buildConciergeHomeA2UI,
  conciergeEnvelope,
  parseConciergeLimit,
  readConciergeHome,
} from '../../../../../lib/headless-projections';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    authorizeConciergeOperation(resolved.context, 'concierge.home.a2ui', {
      tenantSlug: req.nextUrl.searchParams.get('tenant') || undefined,
      organizationId: req.nextUrl.searchParams.get('organization_id') || undefined,
      projectId: req.nextUrl.searchParams.get('project_id') || undefined,
    });
    const summary = readConciergeHome(resolved.context, {
      tenant: req.nextUrl.searchParams.get('tenant'),
      organizationId: req.nextUrl.searchParams.get('organization_id'),
      projectId: req.nextUrl.searchParams.get('project_id'),
      limit: parseConciergeLimit(req.nextUrl.searchParams.get('limit')),
    });
    return NextResponse.json(
      conciergeEnvelope(
        'home',
        { source_resource: 'home', a2ui: buildConciergeHomeA2UI(summary) },
        resolved.context
      )
    );
  } catch (error) {
    return conciergeErrorResponse(error);
  }
}
